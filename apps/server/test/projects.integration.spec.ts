import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/common/tokens';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import { projectTokens } from '../src/db/schema';
import { ProjectsService } from '../src/projects/projects.service';
import { effectiveTokenStatus } from '../src/projects/token-status';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('ProjectsService (integration, testcontainers) — roadmap v1.3, wiele tokenów per projekt + graceful rotation', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let service: ProjectsService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
    service = new ProjectsService(db, config);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('migracje tworzą rozszerzenie vector, kolumnę FTS i indeks HNSW', async () => {
    const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    expect(ext.rowCount).toBe(1);

    const fts = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='fts'",
    );
    expect(fts.rowCount).toBe(1);

    const hnsw = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname='embeddings_vector_hnsw_idx'",
    );
    expect(hnsw.rowCount).toBe(1);
    expect(hnsw.rows[0].indexdef).toContain('hnsw');
    expect(hnsw.rows[0].indexdef).toContain('vector_cosine_ops');
  });

  describe('migration invariants — project_tokens (table/column/type/index shape)', () => {
    it('project_tokens ma wszystkie kolumny oczekiwanego kształtu', async () => {
      const cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='project_tokens'",
      );
      const names = cols.rows.map((r) => r.column_name).sort();
      expect(names).toEqual(
        [
          'id',
          'project_id',
          'token_hash',
          'label',
          'status',
          'created_at',
          'grace_started_at',
          'expires_at',
          'revoked_at',
          'last_used_at',
        ].sort(),
      );
    });

    it('enum project_token_state ma dokładnie active/grace/revoked; project_token_status usunięty', async () => {
      const stateValues = await pool.query(
        "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'project_token_state' ORDER BY enumsortorder",
      );
      expect(stateValues.rows.map((r) => r.enumlabel)).toEqual(['active', 'grace', 'revoked']);

      const oldType = await pool.query("SELECT 1 FROM pg_type WHERE typname = 'project_token_status'");
      expect(oldType.rowCount).toBe(0);
    });

    it('partial unique index project_tokens_project_label_active_key niesie WHERE status=active', async () => {
      const idx = await pool.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'project_tokens_project_label_active_key'",
      );
      expect(idx.rowCount).toBe(1);
      expect(idx.rows[0].indexdef).toContain('WHERE');
      expect(idx.rows[0].indexdef.toLowerCase()).toContain("status = 'active'");
    });

    it('search_events ma nullable token_id (FK do project_tokens)', async () => {
      const col = await pool.query(
        "SELECT is_nullable FROM information_schema.columns WHERE table_name='search_events' AND column_name='token_id'",
      );
      expect(col.rowCount).toBe(1);
      expect(col.rows[0].is_nullable).toBe('YES');
    });

    it('projects nie niesie już żadnej kolumny tokena', async () => {
      const cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='projects'",
      );
      const names = cols.rows.map((r) => r.column_name);
      expect(names).not.toContain('token_hash');
      expect(names).not.toContain('token_status');
      expect(names).not.toContain('token_rotated_at');
    });
  });

  describe('createProject — pierwszy token, hash-only', () => {
    it('mintuje projekt + pierwszy token, zapisuje hash tokena, nigdy plaintext', async () => {
      const { project, token, tokenRow } = await service.createProject('acme');
      expect(project.id).toMatch(/^proj_/);
      expect(token).toMatch(/^ck_/);
      expect(tokenRow.label).toBe('default');
      expect(tokenRow.status).toBe('active');
      expect((tokenRow as Record<string, unknown>).tokenHash).toBeUndefined();

      const [row] = await db.select().from(projectTokens).where(eq(projectTokens.id, tokenRow.id));
      expect(row.tokenHash).toBe(hashToken(token));
      expect(row.tokenHash).not.toBe(token);
      expect(row.projectId).toBe(project.id);
    });

    it('createProject(name, label) honoruje etykietę niestandardową', async () => {
      const { tokenRow } = await service.createProject('acme-custom-label', 'ci-runner');
      expect(tokenRow.label).toBe('ci-runner');
    });
  });

  describe('resolveByToken — lookup + createToken (dual resolution)', () => {
    it('właściwy projekt dla poprawnego tokena, null dla złego/garbage', async () => {
      const { project, token } = await service.createProject('beta');
      const found = await service.resolveByToken(token);
      expect(found?.project.id).toBe(project.id);

      expect(await service.resolveByToken('ck_' + 'x'.repeat(43))).toBeNull();
      expect(await service.resolveByToken('garbage')).toBeNull();
    });

    it('createToken: dwa tokeny aktywne jednocześnie, oba resolvują do tego samego projektu', async () => {
      const { project, token: firstToken } = await service.createProject('gamma', 'agent-one');
      const { token: secondToken, tokenRow } = await service.createToken(project.id, 'agent-two');
      expect(tokenRow.label).toBe('agent-two');

      const resolvedFirst = await service.resolveByToken(firstToken);
      const resolvedSecond = await service.resolveByToken(secondToken);
      expect(resolvedFirst?.project.id).toBe(project.id);
      expect(resolvedSecond?.project.id).toBe(project.id);
      expect(resolvedFirst?.token.id).not.toBe(resolvedSecond?.token.id);
    });

    it('createToken na nieznanym projekcie -> 404', async () => {
      await expect(service.createToken('proj_doesnotexist0', 'x')).rejects.toThrow();
    });
  });

  describe('label validation (normalizeTokenLabel, przez createToken)', () => {
    it('pusty/whitespace-only label -> validation_error', async () => {
      const { project } = await service.createProject('delta-label-empty');
      await expect(service.createToken(project.id, '')).rejects.toMatchObject({ code: 'validation_error' });
      await expect(service.createToken(project.id, '   ')).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('41-znakowy label -> validation_error (max 40); 40 znaków wciąż dozwolone', async () => {
      const { project } = await service.createProject('delta-label-toolong');
      await expect(service.createToken(project.id, 'a'.repeat(41))).rejects.toMatchObject({
        code: 'validation_error',
      });
      const { tokenRow } = await service.createToken(project.id, 'b'.repeat(40));
      expect(tokenRow.label).toHaveLength(40);
    });

    it('nieprawidłowe znaki -> validation_error', async () => {
      const { project } = await service.createProject('delta-label-invalidchar');
      await expect(service.createToken(project.id, 'foo/bar')).rejects.toMatchObject({ code: 'validation_error' });
      await expect(service.createToken(project.id, '.startswithdot')).rejects.toMatchObject({
        code: 'validation_error',
      });
    });

    it('duplikat etykiety WŚRÓD AKTYWNYCH -> validation_error', async () => {
      const { project } = await service.createProject('delta-label-dup', 'agent-a');
      await expect(service.createToken(project.id, 'agent-a')).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('etykieta ponownie użyteczna PO rotate (z inną etykietą zamiennika) lub revoke', async () => {
      // Rotate BEZ jawnej etykiety dziedziczy ją na ZAMIENNIKU (nadal active) — więc "agent-a" jest
      // wciąż zajęta przez zamiennik, nie zwalnia się. Żeby faktycznie zwolnić etykietę, zamiennik
      // musi dostać inną (`opts.label`) — dopiero wtedy STARY wiersz (teraz grace, wciąż "agent-a")
      // jest jedynym posiadaczem etykiety, ale grace nie jest objęty partial index -> wolna.
      const { project, tokenRow: original } = await service.createProject('delta-label-reuse-rotate', 'agent-a');
      await service.rotateToken(original.id, { label: 'agent-a-replacement' });
      const created = await service.createToken(project.id, 'agent-a');
      expect(created.tokenRow.label).toBe('agent-a');

      const { project: project2, tokenRow: original2 } = await service.createProject(
        'delta-label-reuse-revoke',
        'agent-b',
      );
      await service.revokeToken(original2.id);
      const created2 = await service.createToken(project2.id, 'agent-b');
      expect(created2.tokenRow.label).toBe('agent-b');
    });
  });

  describe('graceful rotation', () => {
    it('stary token resolvuje podczas grace, nowy też, oba ten sam projekt', async () => {
      const { project, token: oldToken, tokenRow: oldRow } = await service.createProject('epsilon', 'agent-a');
      const rotated = await service.rotateToken(oldRow.id);

      expect(rotated.previousTokenRow.status).toBe('grace');
      expect(rotated.previousTokenRow.expiresAt).not.toBeNull();
      expect(rotated.tokenRow.status).toBe('active');
      expect(rotated.tokenRow.label).toBe('agent-a'); // dziedziczy etykietę

      const resolvedOld = await service.resolveByToken(oldToken);
      const resolvedNew = await service.resolveByToken(rotated.token);
      expect(resolvedOld?.project.id).toBe(project.id);
      expect(resolvedNew?.project.id).toBe(project.id);
      expect(resolvedOld?.token.id).toBe(oldRow.id);
      expect(resolvedNew?.token.id).toBe(rotated.tokenRow.id);
    });

    it('rotateToken(opts.label) pozwala zmienić etykietę zamiennika', async () => {
      const { tokenRow } = await service.createProject('epsilon-relabel', 'old-label');
      const rotated = await service.rotateToken(tokenRow.id, { label: 'new-label' });
      expect(rotated.tokenRow.label).toBe('new-label');
      expect(rotated.previousTokenRow.label).toBe('old-label'); // stary wiersz nietknięty
    });

    it('rotate token już w grace -> validation_error (guard); rotacja NOWEGO tokena wciąż działa', async () => {
      const { tokenRow } = await service.createProject('epsilon-guard-grace', 'agent-a');
      const rotated = await service.rotateToken(tokenRow.id);
      await expect(service.rotateToken(tokenRow.id)).rejects.toMatchObject({ code: 'validation_error' });
      await expect(service.rotateToken(rotated.tokenRow.id)).resolves.toBeDefined();
    });

    it('rotate token revoked -> validation_error (guard)', async () => {
      const { tokenRow } = await service.createProject('epsilon-guard-revoked', 'agent-a');
      await service.revokeToken(tokenRow.id);
      await expect(service.rotateToken(tokenRow.id)).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('rotate nieznany tokenId -> 404', async () => {
      await expect(service.rotateToken('tok_doesnotexist0')).rejects.toThrow();
    });

    it('concurrent double-rotate na tym samym tokenie -> dokładnie JEDEN zamiennik powstaje', async () => {
      const { project, tokenRow } = await service.createProject('epsilon-concurrent', 'agent-a');
      const results = await Promise.allSettled([
        service.rotateToken(tokenRow.id),
        service.rotateToken(tokenRow.id),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const allTokens = await service.listTokens(project.id);
      const activeTokens = allTokens.filter((t) => t.status === 'active');
      expect(activeTokens).toHaveLength(1); // dokładnie jeden zamiennik, nie dwa
    });
  });

  describe('expiry — lazy, bez nocnego sweepu', () => {
    it('grace token z expires_at w przeszłości przestaje resolvować (bez udziału żadnego joba)', async () => {
      const { tokenRow: oldRow, token: oldPlaintext } = await service.createProject('zeta-expiry', 'agent-a');
      const rotated = await service.rotateToken(oldRow.id);
      expect((await service.resolveByToken(oldPlaintext))?.token.id).toBe(oldRow.id); // wciąż w grace, usable

      // Symulacja upływu czasu — bezpośrednia manipulacja DB (żaden sweep/job w to nie ingeruje;
      // lazy expiry czyta expires_at przy KAŻDYM lookupie, patrz usableTokenCondition()).
      await db
        .update(projectTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(projectTokens.id, oldRow.id));

      const [freshOldRow] = await db.select().from(projectTokens).where(eq(projectTokens.id, oldRow.id));
      expect(effectiveTokenStatus(freshOldRow, new Date())).toBe('expired');

      expect(await service.resolveByToken(oldPlaintext)).toBeNull(); // wygasł -> lazily unusable
      expect((await service.resolveByToken(rotated.token))?.token.id).toBe(rotated.tokenRow.id); // nowy nietknięty
    });
  });

  describe('boundary agreement — usableTokenCondition() (SQL) vs effectiveTokenStatus() (TS)', () => {
    it('expires_at tuż w przyszłości -> grace usable po obu stronach; tuż w przeszłości -> expired/unusable po obu', async () => {
      const { tokenRow } = await service.createProject('eta-boundary', 'agent-a');
      const rotated = await service.rotateToken(tokenRow.id);

      await db
        .update(projectTokens)
        .set({ expiresAt: new Date(Date.now() + 60_000) })
        .where(eq(projectTokens.id, rotated.previousTokenRow.id));
      const [futureRow] = await db.select().from(projectTokens).where(eq(projectTokens.id, rotated.previousTokenRow.id));
      expect(effectiveTokenStatus(futureRow, new Date())).toBe('grace');
      const sqlUsableFuture = await pool.query(
        `SELECT (status = 'active' OR (status = 'grace' AND expires_at > now())) AS usable FROM project_tokens WHERE id = $1`,
        [futureRow.id],
      );
      expect(sqlUsableFuture.rows[0].usable).toBe(true);

      await db
        .update(projectTokens)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(projectTokens.id, rotated.previousTokenRow.id));
      const [pastRow] = await db.select().from(projectTokens).where(eq(projectTokens.id, rotated.previousTokenRow.id));
      expect(effectiveTokenStatus(pastRow, new Date())).toBe('expired');
      const sqlUsablePast = await pool.query(
        `SELECT (status = 'active' OR (status = 'grace' AND expires_at > now())) AS usable FROM project_tokens WHERE id = $1`,
        [pastRow.id],
      );
      expect(sqlUsablePast.rows[0].usable).toBe(false);
    });
  });

  describe('revokeToken — natychmiastowe, idempotentne', () => {
    it('unieważnia token active -> przestaje resolvować natychmiast', async () => {
      const { token, tokenRow } = await service.createProject('theta-revoke-active', 'agent-a');
      expect((await service.resolveByToken(token))?.token.id).toBe(tokenRow.id);

      const revoked = await service.revokeToken(tokenRow.id);
      expect(revoked.status).toBe('revoked');
      expect(revoked.revokedAt).not.toBeNull();
      expect(await service.resolveByToken(token)).toBeNull();
    });

    it('unieważnia token w grace -> przestaje resolvować natychmiast', async () => {
      const { tokenRow, token: oldPlaintext } = await service.createProject('theta-revoke-grace', 'agent-a');
      const rotated = await service.rotateToken(tokenRow.id);
      expect((await service.resolveByToken(oldPlaintext))?.token.id).toBe(tokenRow.id); // grace, wciąż usable

      const revoked = await service.revokeToken(tokenRow.id);
      expect(revoked.status).toBe('revoked');
      expect(await service.resolveByToken(oldPlaintext)).toBeNull();
      // Zamiennik (nowy, active) nietknięty rewokacją starego.
      expect((await service.resolveByToken(rotated.token))?.token.id).toBe(rotated.tokenRow.id);
    });

    it('idempotentny: unieważnienie już-revoked zwraca istniejący wiersz, nie rzuca', async () => {
      const { tokenRow } = await service.createProject('theta-idempotent', 'agent-a');
      const first = await service.revokeToken(tokenRow.id);
      const second = await service.revokeToken(tokenRow.id);
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('revoked');
    });

    it('nieznany tokenId -> 404', async () => {
      await expect(service.revokeToken('tok_doesnotexist0')).rejects.toThrow();
    });
  });

  describe('updateTokenLabel — rename, dowolny status, kolizja tylko wśród aktywnych', () => {
    it('rename działa dla active, grace i revoked', async () => {
      const { project, tokenRow: activeRow } = await service.createProject('iota-rename', 'orig-active');
      const updatedActive = await service.updateTokenLabel(activeRow.id, 'renamed-active');
      expect(updatedActive.label).toBe('renamed-active');

      const { tokenRow: graceSeed } = await service.createToken(project.id, 'orig-grace');
      const rotated = await service.rotateToken(graceSeed.id);
      const updatedGrace = await service.updateTokenLabel(rotated.previousTokenRow.id, 'renamed-grace');
      expect(updatedGrace.label).toBe('renamed-grace');

      const { tokenRow: revokedSeed } = await service.createToken(project.id, 'orig-revoked');
      await service.revokeToken(revokedSeed.id);
      const updatedRevoked = await service.updateTokenLabel(revokedSeed.id, 'renamed-revoked');
      expect(updatedRevoked.label).toBe('renamed-revoked');
    });

    it('rename nie wpływa na usability (usableTokenCondition nietknięty)', async () => {
      const { project, token, tokenRow } = await service.createProject('iota-rename-usability', 'before');
      await service.updateTokenLabel(tokenRow.id, 'after');
      const resolved = await service.resolveByToken(token);
      expect(resolved?.project.id).toBe(project.id);
      expect(resolved?.token.label).toBe('after');
    });

    it('rename do nieprawidłowej etykiety -> validation_error', async () => {
      const { tokenRow } = await service.createProject('iota-rename-invalid');
      await expect(service.updateTokenLabel(tokenRow.id, '')).rejects.toMatchObject({ code: 'validation_error' });
      await expect(service.updateTokenLabel(tokenRow.id, 'a'.repeat(41))).rejects.toMatchObject({
        code: 'validation_error',
      });
    });

    it('rename tokena AKTYWNEGO na etykietę już zajętą przez inny AKTYWNY -> validation_error', async () => {
      const { project } = await service.createProject('iota-rename-collision', 'label-a');
      const { tokenRow: tokenB } = await service.createToken(project.id, 'label-b');
      await expect(service.updateTokenLabel(tokenB.id, 'label-a')).rejects.toMatchObject({
        code: 'validation_error',
      });
    });

    it('rename tokena w grace na etykietę zajętą przez aktywny -> DOZWOLONE (nie jest objęty partial index)', async () => {
      const { project } = await service.createProject('iota-rename-freebie', 'label-active');
      const { tokenRow: graceSeed } = await service.createToken(project.id, 'label-grace-seed');
      const rotated = await service.rotateToken(graceSeed.id); // graceSeed teraz w grace

      const renamed = await service.updateTokenLabel(rotated.previousTokenRow.id, 'label-active');
      expect(renamed.label).toBe('label-active');
    });

    it('nieznany tokenId -> 404', async () => {
      await expect(service.updateTokenLabel('tok_doesnotexist0', 'x')).rejects.toThrow();
    });
  });

  describe('listTokens — projekcja bez token_hash', () => {
    it('nigdy nie zwraca token_hash', async () => {
      const { project } = await service.createProject('kappa-list');
      const rows = await service.listTokens(project.id);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect((row as Record<string, unknown>).tokenHash).toBeUndefined();
      }
    });

    it('zwraca najnowsze pierwsze', async () => {
      const { project, tokenRow: first } = await service.createProject('kappa-order');
      const { tokenRow: second } = await service.createToken(project.id, 'second');
      const rows = await service.listTokens(project.id);
      expect(rows[0].id).toBe(second.id);
      expect(rows[rows.length - 1].id).toBe(first.id);
    });
  });

  describe('countTokensByProject', () => {
    it('grupuje active/grace/revoked poprawnie, grace filtrowany LIVE expires_at', async () => {
      const { project } = await service.createProject('lambda-counts', 'a');
      const { tokenRow: tokenB } = await service.createToken(project.id, 'b');
      const { tokenRow: tokenC } = await service.createToken(project.id, 'c');

      await service.rotateToken(tokenB.id); // b -> grace (live, expires w przyszłości)
      await service.revokeToken(tokenC.id); // c -> revoked

      const counts = await service.countTokensByProject();
      const forProject = counts.get(project.id)!;
      expect(forProject.active).toBe(2); // oryginalny "a" + zamiennik "b"
      expect(forProject.grace).toBe(1);
      expect(forProject.revoked).toBe(1);
    });

    it('grace z expires_at w przeszłości NIE liczy się jako grace (already-expired)', async () => {
      const { project, tokenRow } = await service.createProject('lambda-counts-expired', 'a');
      const rotated = await service.rotateToken(tokenRow.id);
      await db
        .update(projectTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(projectTokens.id, rotated.previousTokenRow.id));

      const counts = await service.countTokensByProject();
      const forProject = counts.get(project.id)!;
      expect(forProject.grace).toBe(0);
    });
  });

  describe('touchTokenUsage — coalescing best-effort', () => {
    it('ustawia last_used_at i throttluje kolejne wywołania w oknie 60s', async () => {
      const { tokenRow } = await service.createProject('mu-touch');
      expect(tokenRow.lastUsedAt).toBeNull();

      service.touchTokenUsage(tokenRow.id);
      // Fire-and-forget — poczekaj chwilę na wylądowanie UPDATE-u.
      let firstStamp: Date | null = null;
      for (let i = 0; i < 20 && !firstStamp; i++) {
        await sleep(25);
        const [row] = await db.select().from(projectTokens).where(eq(projectTokens.id, tokenRow.id));
        firstStamp = row.lastUsedAt;
      }
      expect(firstStamp).not.toBeNull();

      // Drugie wywołanie natychmiast potem — throttle powinien je zjeść (bez nowego UPDATE-u).
      service.touchTokenUsage(tokenRow.id);
      await sleep(100);
      const [row] = await db.select().from(projectTokens).where(eq(projectTokens.id, tokenRow.id));
      expect(row.lastUsedAt?.getTime()).toBe(firstStamp!.getTime());
    });
  });

  describe('updateProject (roadmap v1.2, "kind=event episodic" — dialog szczegółów projektu)', () => {
    it('default includeEventsInDefaultSearch=false dla nowo utworzonego projektu', async () => {
      const { project } = await service.createProject('nu-default');
      expect(project.includeEventsInDefaultSearch).toBe(false);
    });

    it('przełącza includeEventsInDefaultSearch true/false, listProjects odzwierciedla nową wartość', async () => {
      const { project } = await service.createProject('nu-toggle');

      const enabled = await service.updateProject(project.id, { includeEventsInDefaultSearch: true });
      expect(enabled.includeEventsInDefaultSearch).toBe(true);

      const listed = await service.listProjects();
      expect(listed.find((p) => p.id === project.id)?.includeEventsInDefaultSearch).toBe(true);

      const disabled = await service.updateProject(project.id, { includeEventsInDefaultSearch: false });
      expect(disabled.includeEventsInDefaultSearch).toBe(false);
    });

    it('pole pominięte (undefined) -> no-op, zwraca bieżący wiersz bez zmian', async () => {
      const { project } = await service.createProject('nu-noop');
      await service.updateProject(project.id, { includeEventsInDefaultSearch: true });

      const result = await service.updateProject(project.id, {});
      expect(result.includeEventsInDefaultSearch).toBe(true); // niezmienione przez no-op wywołanie
    });

    it('nieznane id -> NotFoundException', async () => {
      await expect(
        service.updateProject('proj_doesnotexist0', { includeEventsInDefaultSearch: true }),
      ).rejects.toThrow();
    });
  });

  describe('slug projektu (roadmap v1.5) — createProject, findBySlug, listProjectSummaries', () => {
    it('slug wyprowadzany z nazwy (polskie znaki), zapisany w kolumnie', async () => {
      const { project } = await service.createProject('Zażółć Gęślą Jaźń');
      expect(project.slug).toBe('zazolc-gesla-jazn');
      expect((await service.findBySlug('zazolc-gesla-jazn'))?.id).toBe(project.id);
    });

    it('duplikat nazwy dostaje sufiks -2, -3', async () => {
      const first = await service.createProject('Slug Dup Name');
      const second = await service.createProject('slug dup name');
      const third = await service.createProject('SLUG-DUP-NAME');
      expect(first.project.slug).toBe('slug-dup-name');
      expect(second.project.slug).toBe('slug-dup-name-2');
      expect(third.project.slug).toBe('slug-dup-name-3');
    });

    it("nazwa bez użytecznych znaków ('!!!') -> project-<końcówka id>", async () => {
      const { project } = await service.createProject('!!!');
      const tail = project.id.replace(/^proj_/, '').replace(/[^a-z0-9]/g, '');
      expect(project.slug).toBe(`project-${tail}`);
    });

    it('jawny slug jest normalizowany (trim + lowercase) i zapisany bez sufiksu', async () => {
      const { project } = await service.createProject('Explicit Slug Project', 'default', { slug: ' Explicit-Slug ' });
      expect(project.slug).toBe('explicit-slug');
    });

    it('jawny slug: zły format -> validation_error; zajęty -> validation_error (bez sufiksu)', async () => {
      await expect(service.createProject('x1', 'default', { slug: 'Bad Slug' })).rejects.toMatchObject({
        code: 'validation_error',
      });
      await service.createProject('Taken Slug Owner', 'default', { slug: 'taken-slug' });
      await expect(service.createProject('x2', 'default', { slug: 'TAKEN-SLUG ' })).rejects.toMatchObject({
        code: 'validation_error',
      });
    });

    it('równoległe createProject z tą samą nazwą: wszystkie się udają, slugi rozłączne (retry po 23505)', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.createProject('Concurrent Slug Race')),
      );
      const slugs = results.map((r) => r.project.slug);
      expect(new Set(slugs).size).toBe(5);
      expect([...slugs].sort()).toEqual(
        [
          'concurrent-slug-race',
          'concurrent-slug-race-2',
          'concurrent-slug-race-3',
          'concurrent-slug-race-4',
          'concurrent-slug-race-5',
        ].sort(),
      );
    });

    it('drizzle owija 23505 w DrizzleQueryError z przyczyną w cause; jawny slug zajęty w wyścigu -> validation_error', async () => {
      // Dokładnie ta ścieżka, którą obsługuje isUniqueViolation: insert przez drizzle łamiący
      // projects_slug_key rzuca DrizzleQueryError BEZ code/constraint (te są w err.cause).
      const { project } = await service.createProject('Drizzle Wrap Probe');
      const wrapped = await db
        .insert(schema.projects)
        .values({ id: 'proj_drizzle_wrap_dup', name: 'dup', slug: project.slug })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(wrapped).toBeInstanceOf(Error);
      expect(wrapped).not.toHaveProperty('code');
      expect(wrapped).toMatchObject({ cause: { code: '23505', constraint: 'projects_slug_key' } });

      // Jawny slug przechodzi pre-check (symulujemy wyścig: slug zajęty dopiero po pre-checku) —
      // wstawiamy konflikt przez spy na assertSlugAvailable.
      const spy = vi.spyOn(service, 'assertSlugAvailable').mockResolvedValueOnce(undefined);
      try {
        await expect(
          service.createProject('Explicit Race Loser', 'default', { slug: project.slug }),
        ).rejects.toMatchObject({ code: 'validation_error' });
      } finally {
        spy.mockRestore();
      }
    });

    it('findBySlug zwraca null dla nieznanego slugu', async () => {
      expect(await service.findBySlug('no-such-slug-at-all')).toBeNull();
    });

    it('listProjectSummaries: {slug, name} posortowane po slugu', async () => {
      const { project } = await service.createProject('Summaries Probe');
      const summaries = await service.listProjectSummaries();
      expect(summaries.find((s) => s.slug === project.slug)).toEqual({ slug: 'summaries-probe', name: 'Summaries Probe' });
      const slugs = summaries.map((s) => s.slug);
      expect(slugs).toEqual([...slugs].sort());
      for (const s of summaries) expect(Object.keys(s).sort()).toEqual(['name', 'slug']);
    });

    it('slug w bazie jest chroniony CHECK-iem i unikalnym indeksem', async () => {
      const { project } = await service.createProject('Slug Constraint Probe');
      await expect(
        pool.query("UPDATE projects SET slug = 'Bad Slug' WHERE id = $1", [project.id]),
      ).rejects.toMatchObject({ constraint: 'projects_slug_format_check' });
      await service.createProject('Slug Constraint Other');
      await expect(
        pool.query("UPDATE projects SET slug = 'slug-constraint-other' WHERE id = $1", [project.id]),
      ).rejects.toMatchObject({ constraint: 'projects_slug_key' });
    });
  });

  describe('isSlugPending / assertSlugAvailable (roadmap v1.5)', () => {
    it('isSlugPending: zapytanie z ::text działa przed migracją B i zwraca false bez propozycji', async () => {
      expect(await service.isSlugPending('nobody-holds-this')).toBe(false);
    });

    it('assertSlugAvailable: zajęty przez projekt -> validation_error; wolny -> ok; excludeProjectId pozwala na własny', async () => {
      const { project } = await service.createProject('Assert Slug Owner');
      await expect(service.assertSlugAvailable(project.slug)).rejects.toMatchObject({ code: 'validation_error' });
      await expect(service.assertSlugAvailable(project.slug, { excludeProjectId: project.id })).resolves.toBeUndefined();
      await expect(service.assertSlugAvailable('assert-slug-free')).resolves.toBeUndefined();
    });
  });

  describe('tokeny konta (project_id IS NULL, roadmap v1.5)', () => {
    it('createAccountToken: projectId null, token ck_, hash-only, widoczny w listAccountTokens', async () => {
      const { token, tokenRow } = await service.createAccountToken('acc-create');
      expect(token).toMatch(/^ck_/);
      expect(tokenRow.projectId).toBeNull();
      expect(tokenRow.status).toBe('active');
      expect('tokenHash' in tokenRow).toBe(false);

      const [raw] = await db.select().from(projectTokens).where(eq(projectTokens.id, tokenRow.id));
      expect(raw.tokenHash).toBe(hashToken(token));
      expect(raw.projectId).toBeNull();

      const listed = await service.listAccountTokens();
      expect(listed.some((t) => t.id === tokenRow.id)).toBe(true);
      for (const row of listed) {
        expect(row.projectId).toBeNull();
        expect('tokenHash' in row).toBe(false);
      }
    });

    it('kolizja etykiety wśród AKTYWNYCH tokenów konta -> validation_error; ta sama etykieta u tokenu projektowego dozwolona', async () => {
      await service.createAccountToken('acc-dup');
      await expect(service.createAccountToken('acc-dup')).rejects.toMatchObject({ code: 'validation_error' });

      // Ta sama etykieta na tokenie PROJEKTOWYM nie koliduje z kontem (inny zakres unikalności)…
      const { tokenRow } = await service.createProject('acc-dup-project', 'acc-dup');
      expect(tokenRow.label).toBe('acc-dup');
      // …i odwrotnie: etykieta tokenu projektowego nie blokuje nowego tokenu konta.
      await service.createProject('acc-dup-project-2', 'acc-only-in-project');
      await expect(service.createAccountToken('acc-only-in-project')).resolves.toBeDefined();
    });

    it('lookupToken: token konta -> project null; token projektowy -> projekt; resolveByToken(konto) -> null', async () => {
      const account = await service.createAccountToken('acc-lookup');
      const { project, token: projectToken } = await service.createProject('acc-lookup-project');

      const accountLookup = await service.lookupToken(account.token);
      expect(accountLookup?.project).toBeNull();
      expect(accountLookup?.token.id).toBe(account.tokenRow.id);
      expect(accountLookup?.token.projectId).toBeNull();

      const projectLookup = await service.lookupToken(projectToken);
      expect(projectLookup?.project?.id).toBe(project.id);

      expect(await service.resolveByToken(account.token)).toBeNull();
      expect((await service.resolveByToken(projectToken))?.project.id).toBe(project.id);
    });

    it('rotateToken na tokenie konta: zamiennik zostaje kontowy, stary w grace (oba resolvują), potem wygasa', async () => {
      const original = await service.createAccountToken('acc-rotate');
      const rotated = await service.rotateToken(original.tokenRow.id);

      expect(rotated.tokenRow.projectId).toBeNull();
      expect(rotated.tokenRow.label).toBe('acc-rotate');
      expect(rotated.previousTokenRow.status).toBe('grace');
      expect((await service.lookupToken(original.token))?.token.id).toBe(original.tokenRow.id);
      expect((await service.lookupToken(rotated.token))?.token.id).toBe(rotated.tokenRow.id);

      await db
        .update(projectTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(projectTokens.id, original.tokenRow.id));
      expect(await service.lookupToken(original.token)).toBeNull();
      expect((await service.lookupToken(rotated.token))?.token.id).toBe(rotated.tokenRow.id);
    });

    it('rotateToken na tokenie konta z kolidującą etykietą zamiennika -> validation_error (komunikat o koncie)', async () => {
      const a = await service.createAccountToken('acc-rot-a');
      await service.createAccountToken('acc-rot-b');
      await expect(service.rotateToken(a.tokenRow.id, { label: 'acc-rot-b' })).rejects.toThrow(/token konta/);
    });

    it('revokeToken na tokenie konta: natychmiastowe, idempotentne', async () => {
      const { token, tokenRow } = await service.createAccountToken('acc-revoke');
      const revoked = await service.revokeToken(tokenRow.id);
      expect(revoked.status).toBe('revoked');
      expect(revoked.projectId).toBeNull();
      expect(await service.lookupToken(token)).toBeNull();
      expect((await service.revokeToken(tokenRow.id)).status).toBe('revoked');
    });

    it('updateTokenLabel na tokenie konta koliduje tylko z aktywnymi tokenami konta', async () => {
      const a = await service.createAccountToken('acc-relabel-a');
      await service.createAccountToken('acc-relabel-b');
      await expect(service.updateTokenLabel(a.tokenRow.id, 'acc-relabel-b')).rejects.toMatchObject({
        code: 'validation_error',
      });
      // Etykieta zajęta wyłącznie przez token PROJEKTOWY nie blokuje zmiany nazwy tokenu konta.
      await service.createProject('acc-relabel-project', 'acc-relabel-project-only');
      const renamed = await service.updateTokenLabel(a.tokenRow.id, 'acc-relabel-project-only');
      expect(renamed.label).toBe('acc-relabel-project-only');
      expect(renamed.projectId).toBeNull();
    });

    it('countTokensByProject nie ma klucza null; listTokens(projectId) nie zawiera tokenów konta', async () => {
      const account = await service.createAccountToken('acc-counts');
      const { project } = await service.createProject('acc-counts-project');

      const counts = await service.countTokensByProject();
      expect(counts.has(null as unknown as string)).toBe(false);
      expect([...counts.keys()].every((k) => typeof k === 'string')).toBe(true);
      expect(counts.get(project.id)?.active).toBe(1);

      const tokens = await service.listTokens(project.id);
      expect(tokens.some((t) => t.id === account.tokenRow.id)).toBe(false);
    });
  });

  describe('resolveProjectScope (serwis + baza, roadmap v1.5)', () => {
    it('token konta + slug -> projekt z atrybucją tokenu konta; brak/nieznany slug -> nierozwiązany', async () => {
      const account = await service.createAccountToken('acc-scope');
      const { project } = await service.createProject('Scope Target');
      const lookup = (await service.lookupToken(account.token))!;

      const res = await service.resolveProjectScope(lookup, 'scope-target');
      expect(res).toEqual({
        status: 'resolved',
        context: {
          projectId: project.id,
          projectName: 'Scope Target',
          includeEventsInDefaultSearch: false,
          tokenId: account.tokenRow.id,
          tokenLabel: 'acc-scope',
        },
      });
      expect((await service.resolveProjectScope(lookup, undefined)).status).toBe('unresolved');
      expect(await service.resolveProjectScope(lookup, 'scope-nope')).toEqual({
        status: 'unresolved',
        reason: 'project_not_found',
        requestedSlug: 'scope-nope',
      });
    });
  });
});
