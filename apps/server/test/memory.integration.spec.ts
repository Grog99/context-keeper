import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { computeContentHash } from '../src/common/content-hash';
import { ToolError } from '../src/common/errors';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import { auditLog, EMBEDDING_DIM, embeddings, proposals, searchEvents, stagingEmbeddings } from '../src/db/schema';
import { generateId, ID_PREFIX } from '../src/common/ids';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { MemoryService } from '../src/memory/memory.service';
import type { ProjectContext } from '../src/projects/projects.service';
import { ProjectsService } from '../src/projects/projects.service';
import { ProposalsService } from '../src/proposals/proposals.service';
import { UsageService } from '../src/usage/usage.service';

/**
 * Testcontainers nie potrafi odpalić prawdziwego sidecara TEI — port `EmbeddingProvider` istnieje
 * właśnie po to, żeby podstawić deterministyczny stub bez HTTP. `register` mapuje DOKŁADNY tekst
 * (np. treść query albo obliczony przez `chunk()` tekst chunku) na wektor; nieznany tekst dostaje
 * `fallback` (nigdy identyczny z jawnie zarejestrowanymi, żeby przypadkowo nie \"wygrał\" testu).
 */
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;
  throwOnEmbed = false;
  private readonly vectors = new Map<string, number[]>();
  private readonly fallback = topicVector(0.9);

  constructor(public model: string) {}

  register(text: string, vector: number[]): void {
    this.vectors.set(text, vector);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.throwOnEmbed) {
      throw new Error('StubEmbeddingProvider: symulowana awaria providera');
    }
    return texts.map((t) => this.vectors.get(t) ?? this.fallback.slice());
  }

  async health(): Promise<boolean> {
    return !this.throwOnEmbed;
  }
}

/** Jednostkowy wektor z kontrolowanym cosine similarity do "query topic" = topicVector(1)
 * (component0 = cos_sim, bo query ma normę 1 i zero wszędzie poza indeksem 0). */
function topicVector(component0: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = component0;
  v[1] = Math.sqrt(Math.max(0, 1 - component0 * component0));
  return v;
}

describe('MemoryService (integration, testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let memory: MemoryService;
  let audit: AuditService;
  let config: AppConfigService;

  let projectA: ProjectContext;
  let projectB: ProjectContext;

  /** Nowa (config, provider, memory service) trójka do testów, które potrzebują własnego stuba/env. */
  function buildMemoryService(
    provider: EmbeddingProvider,
    envOverrides: Record<string, unknown> = {},
  ): { memory: MemoryService; config: AppConfigService } {
    const cfg = new AppConfigService(
      envSchema.parse({ DATABASE_URL: 'postgres://unused', ...envOverrides }),
    );
    return {
      memory: new MemoryService(db, cfg, audit, new EmbeddingService(provider, cfg), new UsageService(db)),
      config: cfg,
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });

    audit = new AuditService(db);
    config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
    projects = new ProjectsService(db, config);
    // Provider "zawsze down" dla WSZYSTKICH istniejących (sprzed Fazy 3) testów poniżej — embedQuery
    // zawsze zwraca null, embedMemoryBestEffort zawsze null -> hybrid degeneruje się dokładnie do
    // starego zachowania FTS-only, więc te testy zostają nietknięte przez dodanie ramienia wektorowego.
    const downProvider = new StubEmbeddingProvider('down-stub');
    downProvider.throwOnEmbed = true;
    memory = new MemoryService(db, config, audit, new EmbeddingService(downProvider, config), new UsageService(db));

    const created = await projects.createProject('memory-test-a');
    projectA = { projectId: created.project.id, projectName: created.project.name };
    const createdB = await projects.createProject('memory-test-b');
    projectB = { projectId: createdB.project.id, projectName: createdB.project.name };
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('save — proposal + idempotencja (FR-M3, FR-M8)', () => {
    it('nowy zapis tworzy proposal pending, id zaczyna się od mem_', async () => {
      const res = await memory.save(
        { header: 'Pierwszy fakt', body: 'Treść pierwszego faktu.', tags: ['a'] },
        projectA,
      );
      expect(res.status).toBe('pending');
      expect(res.id).toMatch(/^mem_/);
    });

    it('proposal ma poprawny kształt: type=create, origin=agent, scope=project, payload z tagami', async () => {
      const res = await memory.save(
        { header: 'Fakt ze szczegółami', body: 'Treść ze szczegółami.', tags: ['x', 'Y'] },
        projectA,
      );
      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectA.projectId));
      const matching = rows.find((p) => (p.payload as { memoryId: string }).memoryId === res.id);

      expect(matching).toBeDefined();
      expect(matching!.type).toBe('create');
      expect(matching!.origin).toBe('agent');
      expect(matching!.status).toBe('pending');
      expect(matching!.scope).toBe('project');
      expect(matching!.projectId).toBe(projectA.projectId);
      expect(matching!.contentHash).toBeTruthy();
      const payload = matching!.payload as { header: string; body: string; tags: string[]; kind: string };
      expect(payload.header).toBe('Fakt ze szczegółami');
      expect(payload.tags).toEqual(['x', 'y']); // znormalizowane (lowercase)
      expect(payload.kind).toBe('fact');
    });

    it('duplicate_pending: identyczny save drugi raz zwraca id ISTNIEJĄCEGO proposala', async () => {
      const first = await memory.save(
        { header: 'Duplikat testowy', body: 'Ta sama treść.' },
        projectA,
      );
      expect(first.status).toBe('pending');

      const second = await memory.save(
        { header: 'Duplikat testowy', body: 'Ta sama treść.' },
        projectA,
      );
      expect(second.status).toBe('duplicate_pending');
      expect(second.id).not.toBe(first.id); // to id PROPOSALA, nie mintowanej pamięci
      expect(second.id).toMatch(/^prop_/);
    });

    it('already_exists: exact match do zatwierdzonej pamięci zwraca id PAMIĘCI', async () => {
      const seeded = await memory.devSeedApproved({
        header: 'Zatwierdzony fakt',
        body: 'Treść już zatwierdzona.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });

      const res = await memory.save(
        { header: 'Zatwierdzony fakt', body: 'Treść już zatwierdzona.' },
        projectA,
      );
      expect(res.status).toBe('already_exists');
      expect(res.id).toBe(seeded.id);
    });

    it('duplicate_pending jest per-projekt: ten sam header+body z INNEGO projektu tworzy NOWY proposal', async () => {
      const a = await memory.save({ header: 'Wspolny tekst', body: 'Identyczna tresc.' }, projectA);
      const b = await memory.save({ header: 'Wspolny tekst', body: 'Identyczna tresc.' }, projectB);
      expect(a.status).toBe('pending');
      expect(b.status).toBe('pending');
      expect(a.id).not.toBe(b.id);
    });

    it('dedup jest kind-aware (roadmap v1.3 "Dedup kind-aware"): identyczny header+body zapisany jako fact, potem jako document -> DRUGI zapis to nowy pending proposal, nie duplicate_pending', async () => {
      const header = 'Kind-aware dedup regresja';
      const body = 'Bajt-w-bajt identyczna tresc, rozne kind.';

      const asFact = await memory.save({ header, body }, projectA);
      expect(asFact.status).toBe('pending');

      const asDocument = await memory.save({ header, body, kind: 'document' }, projectA);
      expect(asDocument.status).toBe('pending'); // NIE duplicate_pending mimo identycznego header+body
      expect(asDocument.id).not.toBe(asFact.id);

      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectA.projectId));
      const matching = rows.filter((p) => (p.payload as { header: string }).header === header);
      expect(matching.length).toBe(2);
      const kinds = matching.map((p) => (p.payload as { kind: string }).kind).sort();
      expect(kinds).toEqual(['document', 'fact']);
    });

    it('already_exists jest kind-aware: zatwierdzony fact tej samej treści NIE blokuje document, ale nadal blokuje kolejny fact', async () => {
      const header = 'Already-exists kind-aware';
      const body = 'Tresc zatwierdzona jako fact.';
      const seeded = await memory.devSeedApproved({
        header,
        body,
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });

      const asDocument = await memory.save({ header, body, kind: 'document' }, projectA);
      expect(asDocument.status).toBe('pending'); // NIE already_exists — inny kind niż zatwierdzony fact

      const asFact = await memory.save({ header, body }, projectA);
      expect(asFact.status).toBe('already_exists');
      expect(asFact.id).toBe(seeded.id);
    });

    it('ten sam kind wciąż dedupuje: identyczny document zapisany dwa razy -> drugi duplicate_pending', async () => {
      const header = 'Document same-kind dedup';
      const body = 'Identyczna tresc dokumentu.';

      const first = await memory.save({ header, body, kind: 'document' }, projectA);
      expect(first.status).toBe('pending');

      const second = await memory.save({ header, body, kind: 'document' }, projectA);
      expect(second.status).toBe('duplicate_pending');
      // `first.id` to zmintowany id PAMIĘCI (create-path zwraca go nawet dla `pending`), `second.id`
      // to id ISTNIEJĄCEGO proposala (jak w teście "duplicate_pending" wyżej) — inny namespace,
      // więc NIE porównujemy ich równości, tylko kształt.
      expect(second.id).not.toBe(first.id);
      expect(second.id).toMatch(/^prop_/);
    });

    it('parytet SQL<->TS: wyrażenie hash z migracji 0011 daje identyczny hex digest co computeContentHash, w tym dla projectId=null', async () => {
      const input = {
        header: 'Parytet SQL i TS',
        body: 'Tresc do porownania hashy.',
        scope: 'project' as const,
        projectId: null as string | null,
        kind: 'fact' as const,
      };
      const tsHash = computeContentHash(input);

      const result = await db.execute<{ hash: string }>(sql`
        SELECT encode(
          sha256(convert_to(
            ${input.header} || chr(31) ||
            ${input.body}   || chr(31) ||
            ${input.scope}  || chr(31) ||
            coalesce(${input.projectId}, '') || chr(31) ||
            ${input.kind},
            'UTF8'
          )),
          'hex'
        ) AS hash
      `);
      expect(result.rows[0].hash).toBe(tsHash);
    });

    it('secret_blocked: sekret w body blokuje zapis, audit log dostaje wpis BEZ materiału sekretu', async () => {
      const before = await db.select().from(proposals).where(eq(proposals.projectId, projectA.projectId));

      await expect(
        memory.save(
          { header: 'Konfiguracja AWS', body: 'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP' },
          projectA,
        ),
      ).rejects.toMatchObject({ code: 'secret_blocked' });

      const after = await db.select().from(proposals).where(eq(proposals.projectId, projectA.projectId));
      expect(after.length).toBe(before.length); // żaden proposal nie powstał

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'secret_blocked'));
      expect(auditRows.length).toBeGreaterThan(0);
      const metadata = auditRows[auditRows.length - 1].metadata as { secretType: string };
      expect(metadata.secretType).toBe('aws_access_key');
      // Bez materiału sekretu w audycie:
      expect(JSON.stringify(auditRows[auditRows.length - 1])).not.toContain('AKIAABCDEFGHIJKLMNOP');
    });

    it('validation_error: header za długi, tag spoza charsetu, body za duże', async () => {
      await expect(
        memory.save({ header: 'a'.repeat(300), body: 'trescc' }, projectA),
      ).rejects.toMatchObject({ code: 'validation_error' });

      await expect(
        memory.save({ header: 'ok', body: 'tresc', tags: ['zly tag!'] }, projectA),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('kind=document: proposal ma payload.kind=document, reszta kształtu jak fact (type=create, origin=agent, scope=project)', async () => {
      const res = await memory.save(
        { header: 'Dokument testowy', body: 'Treść dokumentu testowego.', kind: 'document' },
        projectA,
      );
      expect(res.status).toBe('pending');

      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectA.projectId));
      const matching = rows.find((p) => (p.payload as { memoryId: string }).memoryId === res.id);

      expect(matching).toBeDefined();
      expect(matching!.type).toBe('create');
      expect(matching!.origin).toBe('agent');
      expect(matching!.status).toBe('pending');
      expect(matching!.scope).toBe('project');
      const payload = matching!.payload as { header: string; body: string; tags: string[]; kind: string };
      expect(payload.kind).toBe('document');
    });

    it('kind=document dostaje szerszy limit body niż fact: między BODY_MAX_FACT a BODY_MAX_DOCUMENT — accepted jako document, rejected jako fact', async () => {
      const bodyBetweenLimits = 'x'.repeat(config.get('BODY_MAX_FACT') + 1000);
      expect(bodyBetweenLimits.length).toBeLessThan(config.get('BODY_MAX_DOCUMENT'));

      const asDocument = await memory.save(
        { header: 'Duzy dokument', body: bodyBetweenLimits, kind: 'document' },
        projectA,
      );
      expect(asDocument.status).toBe('pending');

      await expect(
        memory.save({ header: 'Duzy fakt', body: bodyBetweenLimits, kind: 'fact' }, projectA),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
  });

  describe('save — supersedes (roadmap v1.2, "Edycja pamięci przez agenta")', () => {
    let projectSuper: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-supersedes');
      projectSuper = { projectId: created.project.id, projectName: created.project.name };
    });

    it('happy: supersedes na approved fact tego samego projektu -> pending, proposal type=update/origin=agent, payload=poprawiona tresc, affectedIds/baseVersions na target', async () => {
      const target = await memory.devSeedApproved({
        header: 'Stary fakt do poprawy',
        body: 'Stara, nieaktualna tresc.',
        kind: 'fact',
        scope: 'project',
        projectId: projectSuper.projectId,
      });

      const res = await memory.save(
        { header: 'Poprawiony fakt', body: 'Nowa, poprawiona tresc.', supersedes: target.id },
        projectSuper,
      );
      expect(res.status).toBe('pending');
      expect(res.id).toMatch(/^prop_/); // id proposala korekty, NIE id targetu

      const [proposalRow] = await db.select().from(proposals).where(eq(proposals.id, res.id));
      expect(proposalRow).toBeDefined();
      expect(proposalRow.type).toBe('update');
      expect(proposalRow.origin).toBe('agent');
      expect(proposalRow.status).toBe('pending');
      expect(proposalRow.scope).toBe('project');
      expect(proposalRow.projectId).toBe(projectSuper.projectId);
      expect(proposalRow.affectedIds).toEqual([target.id]);
      expect(proposalRow.baseVersions).toEqual({ [target.id]: target.version });
      const payload = proposalRow.payload as { memoryId: string; header: string; body: string; kind: string };
      expect(payload.memoryId).toBe(target.id);
      expect(payload.header).toBe('Poprawiony fakt');
      expect(payload.body).toBe('Nowa, poprawiona tresc.');
      expect(payload.kind).toBe('fact');
    });

    it('IDOR: target z INNEGO projektu -> not_found, identyczne jak nieznane id (anty-probing)', async () => {
      const targetB = await memory.devSeedApproved({
        header: 'Fakt projektu B do probingu',
        body: 'Widoczny tylko w B.',
        kind: 'fact',
        scope: 'project',
        projectId: projectB.projectId,
      });

      await expect(
        memory.save(
          { header: 'Proba korekty cudzego faktu', body: 'Tresc.', supersedes: targetB.id },
          projectSuper,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });

      await expect(
        memory.save(
          { header: 'Proba korekty nieznanego id', body: 'Tresc.', supersedes: 'mem_doesnotexist9' },
          projectSuper,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('target scope=global -> validation_error (nie not_found — globale są widoczne agentowi)', async () => {
      const targetGlobal = await memory.devSeedApproved({
        header: 'Fakt globalny do poprawy',
        body: 'Tresc globalna.',
        kind: 'fact',
        scope: 'global',
      });

      await expect(
        memory.save(
          { header: 'Proba korekty global', body: 'Tresc.', supersedes: targetGlobal.id },
          projectSuper,
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('target kind=event -> validation_error (event jest human-only)', async () => {
      const [eventRow] = await db
        .insert(schema.memories)
        .values({
          id: generateId(ID_PREFIX.memory),
          header: 'Zdarzenie do poprawy',
          body: 'Tresc zdarzenia.',
          kind: 'event',
          tags: [],
          scope: 'project',
          projectId: projectSuper.projectId,
          status: 'approved',
          source: 'human',
          approvedAt: new Date(),
          eventTime: new Date(),
        })
        .returning();

      await expect(
        memory.save(
          { header: 'Proba korekty eventu', body: 'Tresc.', kind: 'fact', supersedes: eventRow.id },
          projectSuper,
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('kind=event + supersedes -> validation_error z wczesnego guarda (roadmap v1.3 "kind=event przez agenta", decyzja #3), PRZED jakimkolwiek lookupem targetu', async () => {
      await expect(
        memory.save(
          {
            header: 'Proba korekty eventu przez event',
            body: 'Tresc.',
            kind: 'event',
            eventTime: '2026-03-01T09:00:00Z',
            supersedes: 'mem_nieistniejacy_target',
          },
          projectSuper,
        ),
      ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('human-only') });
    });

    it('kind mismatch: target document, save kind=fact (domyślny) -> validation_error', async () => {
      const targetDoc = await memory.devSeedApproved({
        header: 'Dokument do poprawy',
        body: 'Tresc dokumentu.',
        kind: 'document',
        scope: 'project',
        projectId: projectSuper.projectId,
      });

      await expect(
        memory.save(
          { header: 'Proba fact zamiast document', body: 'Tresc.', supersedes: targetDoc.id },
          projectSuper,
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('dedup nie suppresuje supersede: pending create o identycznej treści istnieje, supersede tą samą treścią innego targetu nadal type=update (nie duplicate_pending)', async () => {
      const target = await memory.devSeedApproved({
        header: 'Fakt do poprawy (dedup test)',
        body: 'Stara tresc dedup test.',
        kind: 'fact',
        scope: 'project',
        projectId: projectSuper.projectId,
      });

      const createRes = await memory.save(
        { header: 'Wspolna tresc dedup', body: 'Identyczny header+body co supersede.' },
        projectSuper,
      );
      expect(createRes.status).toBe('pending');

      const supersedeRes = await memory.save(
        { header: 'Wspolna tresc dedup', body: 'Identyczny header+body co supersede.', supersedes: target.id },
        projectSuper,
      );
      expect(supersedeRes.status).toBe('pending'); // NIE duplicate_pending mimo identycznego content hash
      expect(supersedeRes.id).not.toBe(createRes.id);

      const [proposalRow] = await db.select().from(proposals).where(eq(proposals.id, supersedeRes.id));
      expect(proposalRow.type).toBe('update');
    });

    it('sekret w poprawionej treści -> secret_blocked, żaden proposal update nie powstaje', async () => {
      const target = await memory.devSeedApproved({
        header: 'Fakt do poprawy z sekretem',
        body: 'Czysta stara tresc.',
        kind: 'fact',
        scope: 'project',
        projectId: projectSuper.projectId,
      });

      const before = await db.select().from(proposals).where(eq(proposals.projectId, projectSuper.projectId));

      await expect(
        memory.save(
          {
            header: 'Proba z sekretem',
            body: 'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP',
            supersedes: target.id,
          },
          projectSuper,
        ),
      ).rejects.toMatchObject({ code: 'secret_blocked' });

      const after = await db.select().from(proposals).where(eq(proposals.projectId, projectSuper.projectId));
      expect(after.length).toBe(before.length); // żaden proposal nie powstał
    });

    it('idempotentny retry: dwa identyczne supersede -> drugi duplicate_pending wskazuje na pierwszy, dokładnie 1 proposal update dla targetu', async () => {
      const target = await memory.devSeedApproved({
        header: 'Fakt do wielokrotnej poprawy',
        body: 'Stara tresc retry test.',
        kind: 'fact',
        scope: 'project',
        projectId: projectSuper.projectId,
      });

      const first = await memory.save(
        { header: 'Poprawiony retry', body: 'Nowa tresc retry.', supersedes: target.id },
        projectSuper,
      );
      expect(first.status).toBe('pending');

      const second = await memory.save(
        { header: 'Poprawiony retry', body: 'Nowa tresc retry.', supersedes: target.id },
        projectSuper,
      );
      expect(second.status).toBe('duplicate_pending');
      expect(second.id).toBe(first.id);

      const rows = await db
        .select()
        .from(proposals)
        .where(and(eq(proposals.projectId, projectSuper.projectId), eq(proposals.type, 'update')));
      const matching = rows.filter((r) => (r.payload as { memoryId: string }).memoryId === target.id);
      expect(matching.length).toBe(1);
    });

    it('backward compat: save bez supersedes nadal tworzy proposal type=create', async () => {
      const res = await memory.save(
        { header: 'Zwykly nowy fakt bez supersedes', body: 'Tresc zwyklego zapisu.' },
        projectSuper,
      );
      expect(res.status).toBe('pending');

      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectSuper.projectId));
      const matching = rows.find((p) => (p.payload as { memoryId: string }).memoryId === res.id);
      expect(matching?.type).toBe('create');
    });
  });

  describe('save — relations, resolveRelations taksonomia (roadmap v1.2, "memory-relations + 1-hop graph boost")', () => {
    let projectRel: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-relations');
      projectRel = { projectId: created.project.id, projectName: created.project.name };
    });

    it('self-loop: relations targetId === self (supersedes target) -> validation_error', async () => {
      const target = await memory.devSeedApproved({
        header: 'Self-loop target',
        body: 'Tresc.',
        kind: 'fact',
        scope: 'project',
        projectId: projectRel.projectId,
      });

      await expect(
        memory.save(
          {
            header: 'Self-loop probe',
            body: 'Tresc.',
            supersedes: target.id,
            relations: [{ type: 'follows', targetId: target.id }],
          },
          projectRel,
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('relations targetId z INNEGO projektu -> not_found (IDOR-safe, identycznie jak supersedes)', async () => {
      const targetB = await memory.devSeedApproved({
        header: 'Relacja do cudzego projektu',
        body: 'Widoczny tylko w B.',
        kind: 'fact',
        scope: 'project',
        projectId: projectB.projectId,
      });

      await expect(
        memory.save(
          {
            header: 'Proba relacji do innego projektu',
            body: 'Tresc.',
            relations: [{ type: 'follows', targetId: targetB.id }],
          },
          projectRel,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('relations > MAX_RELATIONS_PER_SAVE (16) -> validation_error, PRZED jakimkolwiek lookupem targetu', async () => {
      const tooMany = Array.from({ length: 17 }, (_, i) => ({
        type: 'follows' as const,
        targetId: `mem_doesnotexist_rel${i}`,
      }));

      await expect(
        memory.save({ header: 'Zbyt wiele relations', body: 'Tresc.', relations: tooMany }, projectRel),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('duplikat {type,targetId} w relations -> ciche scalanie do JEDNEGO wpisu w payload proposala (bez błędu)', async () => {
      const target = await memory.devSeedApproved({
        header: 'Cel duplikatu relations',
        body: 'Tresc.',
        kind: 'fact',
        scope: 'project',
        projectId: projectRel.projectId,
      });

      const res = await memory.save(
        {
          header: 'Fakt z duplikatem relations',
          body: 'Tresc.',
          relations: [
            { type: 'follows', targetId: target.id },
            { type: 'follows', targetId: target.id },
          ],
        },
        projectRel,
      );
      expect(res.status).toBe('pending');

      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectRel.projectId));
      const match = rows.find((p) => (p.payload as { memoryId: string }).memoryId === res.id);
      expect(match).toBeDefined();
      const payload = match!.payload as { relations?: { type: string; targetId: string }[] };
      expect(payload.relations).toHaveLength(1);
      expect(payload.relations![0]).toEqual({ type: 'follows', targetId: target.id });
    });
  });

  describe('get — scope/IDOR (FR-M2, NFR-1, priorytet 2 wg §15)', () => {
    it('zwraca pełne body dla approved memory we własnym projekcie + bumpuje access_count', async () => {
      const seeded = await memory.devSeedApproved({
        header: 'Fakt do odczytu',
        body: 'Pełna treść do odczytu.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });

      const res1 = await memory.get(seeded.id, projectA);
      expect(res1.body).toBe('Pełna treść do odczytu.');
      expect(res1.accessCount).toBe(1);

      const res2 = await memory.get(seeded.id, projectA);
      expect(res2.accessCount).toBe(2);
    });

    it('cross-project -> not_found (IDOR)', async () => {
      const seeded = await memory.devSeedApproved({
        header: 'Fakt projektu A',
        body: 'Widoczny tylko w A.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });

      await expect(memory.get(seeded.id, projectB)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('nieistniejące id daje IDENTYCZNY błąd co cross-project (anty-probing)', async () => {
      let crossProjectErr: unknown;
      let missingErr: unknown;

      const seeded = await memory.devSeedApproved({
        header: 'Kolejny fakt A',
        body: 'Tresc.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });

      try {
        await memory.get(seeded.id, projectB);
      } catch (e) {
        crossProjectErr = e;
      }
      try {
        await memory.get('mem_doesnotexist0', projectB);
      } catch (e) {
        missingErr = e;
      }

      expect(crossProjectErr).toBeInstanceOf(ToolError);
      expect(missingErr).toBeInstanceOf(ToolError);
      expect((crossProjectErr as ToolError).code).toBe('not_found');
      expect((missingErr as ToolError).code).toBe('not_found');
    });

    it('global memory widoczna z KAŻDEGO projektu', async () => {
      const seeded = await memory.devSeedApproved({
        header: 'Fakt globalny',
        body: 'Widoczny wszędzie.',
        kind: 'fact',
        scope: 'global',
      });

      expect((await memory.get(seeded.id, projectA)).body).toBe('Widoczny wszędzie.');
      expect((await memory.get(seeded.id, projectB)).body).toBe('Widoczny wszędzie.');
    });

    it('archived memory -> not_found (nie jest approved)', async () => {
      const [archived] = await db
        .insert(schema.memories)
        .values({
          id: 'mem_archivedtest1',
          header: 'Zarchiwizowany fakt',
          body: 'Nie powinien być widoczny.',
          kind: 'fact',
          scope: 'project',
          projectId: projectA.projectId,
          status: 'archived',
          source: 'human',
        })
        .returning();

      await expect(memory.get(archived.id, projectA)).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('search — FTS na approved memories (FR-M1, FR-R1-R4, scope)', () => {
    it('znajduje seedowaną approved memory po tekście z headera/body', async () => {
      await memory.devSeedApproved({
        header: 'Konfiguracja PostgreSQL z pgvector',
        body: 'Uzywamy rozszerzenia pgvector oraz indeksu HNSW do wektorow.',
        kind: 'fact',
        tags: ['postgres', 'pgvector'],
        scope: 'project',
        projectId: projectA.projectId,
      });

      const results = await memory.search({ query: 'pgvector' }, projectA);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.header.includes('pgvector'))).toBe(true);
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('respektuje scope: memory innego projektu niewidoczna, global widoczna wszędzie', async () => {
      const marker = 'xylofon77unikalny';
      await memory.devSeedApproved({
        header: `Fakt prywatny projektu A ${marker}`,
        body: 'Tresc prywatna.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });
      await memory.devSeedApproved({
        header: `Fakt globalny ${marker}`,
        body: 'Tresc globalna.',
        kind: 'fact',
        scope: 'global',
      });

      const fromA = await memory.search({ query: marker }, projectA);
      const fromB = await memory.search({ query: marker }, projectB);

      expect(fromA.length).toBe(2); // prywatny A + globalny
      expect(fromB.length).toBe(1); // tylko globalny
      expect(fromB[0].header).toContain('globalny');
    });

    it('filtr kind zawęża wyniki', async () => {
      const marker = 'kindfiltermarker99';
      await memory.devSeedApproved({
        header: `Fakt ${marker}`,
        body: 'To jest fakt.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });
      await memory.devSeedApproved({
        header: `Dokument ${marker}`,
        body: 'To jest dokument.',
        kind: 'document',
        scope: 'project',
        projectId: projectA.projectId,
      });

      const onlyFacts = await memory.search({ query: marker, kind: 'fact' }, projectA);
      const onlyDocs = await memory.search({ query: marker, kind: 'document' }, projectA);
      const both = await memory.search({ query: marker }, projectA);

      expect(onlyFacts.every((r) => r.header.startsWith('Fakt'))).toBe(true);
      expect(onlyDocs.every((r) => r.header.startsWith('Dokument'))).toBe(true);
      expect(both.length).toBe(onlyFacts.length + onlyDocs.length);
    });

    it('filtr tagów (any-of match) zawęża wyniki', async () => {
      const marker = 'tagfiltermarker42';
      await memory.devSeedApproved({
        header: `Z tagiem ${marker}`,
        body: 'Tresc.',
        kind: 'fact',
        tags: ['specialny-tag'],
        scope: 'project',
        projectId: projectA.projectId,
      });
      await memory.devSeedApproved({
        header: `Bez tagu ${marker}`,
        body: 'Tresc.',
        kind: 'fact',
        tags: ['inny-tag'],
        scope: 'project',
        projectId: projectA.projectId,
      });

      const tagged = await memory.search({ query: marker, tags: ['specialny-tag'] }, projectA);
      expect(tagged.length).toBe(1);
      expect(tagged[0].header).toContain('Z tagiem');
    });

    it('pusty wynik (brak dopasowań) to pusta lista, nie błąd', async () => {
      const results = await memory.search({ query: 'zupelnieniepowiazanafraza999xyz' }, projectA);
      expect(results).toEqual([]);
    });

    it('validation_error dla pustego query', async () => {
      await expect(memory.search({ query: '   ' }, projectA)).rejects.toMatchObject({
        code: 'validation_error',
      });
    });
  });

  describe('search — hybrid retrieval (Faza 3, FR-R2-R5)', () => {
    let projectH: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-hybrid');
      projectH = { projectId: created.project.id, projectName: created.project.name };
    });

    it('ramię wektorowe: trafienie WYŁĄCZNIE semantyczne (D) pojawia się w wynikach, mimo zera wspólnych tokenów z query', async () => {
      const provider = new StubEmbeddingProvider('hybrid-test-model');
      // SEARCH_VECTOR_CANDIDATES=2: dystraktor D (dist 0.5) zostaje w oknie kandydatów ramienia
      // wektorowego, ale F (dist 1, najdalszy) zostaje z niego wypchnięty. To SAMO w sobie NIE
      // wystarcza — RRF sumuje 1/(k+rank) po listach (przemienne), więc "S tylko w wektorze @rank1"
      // vs "F tylko w FTS @rank1" to ZAWSZE dokładny remis niezależnie od dowolnych innych
      // kandydatów. Żeby S deterministycznie wygrał, S musi też być obecny w ramieniu FTS (i to
      // jest realistyczne: dokument może jednocześnie pasować leksykalnie i semantycznie) —
      // S powtarza frazę zapytania (silniejszy ts_rank niż F, który ma ją raz), F zostaje CAŁKOWICIE
      // poza ramieniem wektorowym (dist 1 > oba inne kandydaty, wypchnięty przez limit=2).
      //
      // UNGAMEABLE CHECK: samo "S przed F" NIE dowodzi, że ramię wektorowe cokolwiek robi — S ma
      // dominujący ts_rank (fraza zapytania 2x: header+body) i wygrywa z F w RRF WYŁĄCZNIE dzięki
      // FTS, nawet gdyby ramię wektorowe zwróciło pustą listę (policzone: S=1/61≈0.01639 z samego
      // FTS vs F=1/62≈0.01613 — S i tak wygrywa). Dlatego właściwym dowodem, że ramię wektorowe
      // realnie kontrybuuje, jest obecność D w wynikach: D ma ZERO wspólnych tokenów z query (nie
      // matchuje `fts @@ tsquery` w ogóle, więc nigdy nie trafia do listy FTS), a jego jedyna droga
      // do `fused` to lista wektorowa (dist 0.5, rank 2 w oknie limit=2). Gdyby ramię wektorowe było
      // zepsute/puste, D nie miałby ŻADNEGO wkładu w żadnej liście -> w ogóle nie pojawiłby się w
      // `rrfFuse` -> asercja `ids).toContain(seededD.id)` poniżej by nie przeszła.
      const { memory: hybridMemory } = buildMemoryService(provider, { SEARCH_VECTOR_CANDIDATES: 2 });

      const query = 'usluga niedostepna hybrydtest01';
      provider.register(query, topicVector(1));

      // WAŻNE: wektor musi być zarejestrowany PRZED devSeedApproved — to ono woła embed() na
      // dokładnym tekście chunku i zapisuje zwrócony wektor do bazy. Rejestracja PO zapisie
      // spóźniłaby się (baza dostałaby wektor `fallback`, nie ten zamierzony).

      // S: fraza zapytania powtórzona (header + body) -> wysoki ts_rank; wektor IDENTYCZNY z query.
      const sHeader = 'usluga niedostepna hybrydtest01';
      const sBody = 'Usluga niedostepna hybrydtest01 — powtórnie odnotowana awaria w nocy.';
      provider.register(`${sHeader}\n\n${sBody}`, topicVector(1));
      const seededS = await hybridMemory.devSeedApproved({
        header: sHeader,
        body: sBody,
        kind: 'fact',
        scope: 'project',
        projectId: projectH.projectId,
      });

      // F: fraza zapytania obecna RAZ (słabszy ts_rank niż S), wektor ORTOGONALNY (semantycznie daleko).
      const fHeader = 'Zgloszenie serwisowe ABC789';
      const fBody = 'usluga niedostepna hybrydtest01 zgloszona przez klienta bez odpowiedzi.';
      provider.register(`${fHeader}\n\n${fBody}`, topicVector(0));
      const seededF = await hybridMemory.devSeedApproved({
        header: fHeader,
        body: fBody,
        kind: 'fact',
        scope: 'project',
        projectId: projectH.projectId,
      });

      // D: bez ŻADNYCH wspólnych tokenów z query (nie matchuje FTS w ogóle -> niemożliwy do znalezienia
      // przez ramię FTS), wektor W POŁOWIE drogi -> zajmuje rank 2 w oknie wektorowym (limit=2),
      // wypychając F (rank 3 pod względem dystansu) poza to okno. D jest jedynym memory w tym teście,
      // które ramię FTS nigdy nie zwróci — jego obecność w wynikach dowodzi ramienia wektorowego wprost.
      const dHeader = 'Notatka niepowiazana ABC789';
      const dBody = 'Calkowicie inny temat, bez zwiazku z zapytaniem.';
      provider.register(`${dHeader}\n\n${dBody}`, topicVector(0.5));
      const seededD = await hybridMemory.devSeedApproved({
        header: dHeader,
        body: dBody,
        kind: 'fact',
        scope: 'project',
        projectId: projectH.projectId,
      });

      const results = await hybridMemory.search({ query }, projectH);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(seededS.id);
      expect(ids).toContain(seededF.id);
      expect(ids.indexOf(seededS.id)).toBeLessThan(ids.indexOf(seededF.id));

      // Ungameable: D nie ma ŻADNYCH wspólnych tokenów z query, więc `fts @@ tsquery` nigdy go nie
      // zwróci — jedyna droga do wyników to ramię wektorowe. Gdyby ramię wektorowe zwracało puste
      // wyniki (lub w ogóle nie istniało), D nie miałoby wkładu w żadnej liście przekazanej do
      // `rrfFuse` i w ogóle by się nie pojawiło we `fused` — ta asercja nie przeszłaby.
      expect(ids).toContain(seededD.id);
    });

    it('fail-open: provider embeddingów rzuca -> search nie rzuca, wraca do wyniku FTS-only', async () => {
      const marker = 'failopenhybrydmarker77';
      await memory.devSeedApproved({
        header: `Fakt fail-open ${marker}`,
        body: 'Trescy do znalezienia przez FTS mimo padnietego providera.',
        kind: 'fact',
        scope: 'project',
        projectId: projectH.projectId,
      });

      const throwingProvider = new StubEmbeddingProvider('throwing-model');
      throwingProvider.throwOnEmbed = true;
      const { memory: throwingMemory } = buildMemoryService(throwingProvider);

      const results = await throwingMemory.search({ query: marker }, projectH);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.header.includes(marker))).toBe(true);
    });

    it('filtr aktywnego modelu (FR-R5): embedding pod STARYM modelem nie bierze udziału w ramieniu wektorowym', async () => {
      const [staleMemory] = await db
        .insert(schema.memories)
        .values({
          id: generateId(ID_PREFIX.memory),
          header: 'Fakt pod starym modelem modelfiltertest55',
          body: 'Tresc bez wspolnych tokenow z zapytaniem semantycznym.',
          kind: 'fact',
          tags: [],
          scope: 'project',
          projectId: projectH.projectId,
          status: 'approved',
          source: 'human',
          approvedAt: new Date(),
        })
        .returning();

      await db.insert(embeddings).values({
        id: generateId(ID_PREFIX.embedding),
        memoryId: staleMemory.id,
        chunkIndex: 0,
        chunkText: 'stary model — nieużywane w asercji',
        embeddingModel: 'model-old-stale',
        vector: topicVector(1),
      });

      const activeProvider = new StubEmbeddingProvider('model-active-new');
      const { memory: activeMemory } = buildMemoryService(activeProvider);

      // (1) Query semantycznie IDENTYCZNE do zapisanego (stale-model) wektora, ale ZERO wspólnych
      // tokenów z tresc/header -> gdyby filtr modelu nie działał, ramię wektorowe by to znalazło.
      const semanticQuery = 'zupelnieinnaFrazaModelTest999';
      activeProvider.register(semanticQuery, topicVector(1));
      const semanticResults = await activeMemory.search({ query: semanticQuery }, projectH);
      expect(semanticResults.some((r) => r.id === staleMemory.id)).toBe(false);

      // (2) Query z dokładnym tokenem z headera -> FTS wciąż znajduje, niezależnie od modelu wektora.
      const lexicalResults = await activeMemory.search({ query: 'modelfiltertest55' }, projectH);
      expect(lexicalResults.some((r) => r.id === staleMemory.id)).toBe(true);
    });
  });

  describe('search — instrumentacja search_events (roadmap v1.1, "Pomiary")', () => {
    let projectI: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-usage-instrumentation');
      projectI = { projectId: created.project.id, projectName: created.project.name };
    });

    /** Ostatni zapisany `search_events` dla projektu — testy tego bloku są jedynym producentem
     * wierszy dla `projectI`, więc "ostatni po created_at" == "ten z wywołania, które właśnie
     * sprawdzamy" (brak współbieżnych zapisów w tym projekcie). */
    async function lastSearchEvent(projectId: string) {
      const rows = await db
        .select()
        .from(searchEvents)
        .where(eq(searchEvents.projectId, projectId))
        .orderBy(desc(searchEvents.createdAt));
      return rows[0];
    }

    it('dopasowanie: jeden wiersz z result_count>0, degraded=false', async () => {
      const provider = new StubEmbeddingProvider('usage-instrumentation-model');
      const { memory: healthyMemory } = buildMemoryService(provider);

      const marker = 'instrumentacjadopasowaniemarker1';
      provider.register(marker, topicVector(1));
      await healthyMemory.devSeedApproved({
        header: `Fakt ${marker}`,
        body: 'Trescy do dopasowania FTS.',
        kind: 'fact',
        scope: 'project',
        projectId: projectI.projectId,
      });

      const before = (await db.select().from(searchEvents).where(eq(searchEvents.projectId, projectI.projectId)))
        .length;
      const results = await healthyMemory.search({ query: marker }, projectI);
      expect(results.length).toBeGreaterThan(0);

      const after = await db.select().from(searchEvents).where(eq(searchEvents.projectId, projectI.projectId));
      expect(after.length).toBe(before + 1); // DOKŁADNIE jeden nowy wiersz per search()

      const row = await lastSearchEvent(projectI.projectId);
      expect(row.resultCount).toBe(results.length);
      expect(row.resultCount).toBeGreaterThan(0);
      expect(row.degraded).toBe(false);
      expect(row.id).toMatch(/^sev_/);
    });

    it('brak dopasowań: wiersz z result_count=0, degraded=false (prawdziwy zero-result, nie degradacja)', async () => {
      const provider = new StubEmbeddingProvider('usage-instrumentation-model-2');
      const { memory: healthyMemory } = buildMemoryService(provider);

      const results = await healthyMemory.search({ query: 'zupelnieniepowiazanafrazainstrumentacja777' }, projectI);
      expect(results).toEqual([]);

      const row = await lastSearchEvent(projectI.projectId);
      expect(row.resultCount).toBe(0);
      expect(row.degraded).toBe(false);
    });

    it('embedding provider padnięty: wiersz ma degraded=true (fail-open — search NIE rzuca)', async () => {
      const throwingProvider = new StubEmbeddingProvider('usage-instrumentation-down-model');
      throwingProvider.throwOnEmbed = true;
      const { memory: downMemory } = buildMemoryService(throwingProvider);

      const results = await downMemory.search({ query: 'dowolnezapytanieinstrumentacja' }, projectI);
      expect(Array.isArray(results)).toBe(true); // search() nie rzuciło mimo padniętego providera

      const row = await lastSearchEvent(projectI.projectId);
      expect(row.degraded).toBe(true);
    });
  });

  describe('search — default-kind toggle dla kind=event (roadmap v1.2, "kind=event episodic")', () => {
    let projectToggle: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-event-toggle');
      projectToggle = { projectId: created.project.id, projectName: created.project.name };
    });

    /** `devSeedApproved` nie zna jeszcze `eventTime` (poza zakresem tego DEV-ONLY helpera) — insert
     * bezpośredni, jak istniejący test 'archived memory -> not_found' wyżej w tym pliku. */
    async function seedEvent(header: string, eventTime: Date, projectId: string) {
      const [row] = await db
        .insert(schema.memories)
        .values({
          id: generateId(ID_PREFIX.memory),
          header,
          body: 'Treść zdarzenia testowego (toggle default-kind).',
          kind: 'event',
          tags: [],
          scope: 'project',
          projectId,
          status: 'approved',
          source: 'human',
          approvedAt: new Date(),
          eventTime,
        })
        .returning();
      return row;
    }

    it('toggle=false (default): event NIEOBECNY w domyślnym search, OBECNY przy jawnym kind=event', async () => {
      const marker = 'eventtoggledefaultmarker1';
      const seeded = await seedEvent(`Zdarzenie ${marker}`, new Date(), projectToggle.projectId);

      const defaultResults = await memory.search({ query: marker }, projectToggle);
      expect(defaultResults.some((r) => r.id === seeded.id)).toBe(false);

      const explicitResults = await memory.search({ query: marker, kind: 'event' }, projectToggle);
      expect(explicitResults.some((r) => r.id === seeded.id)).toBe(true);
    });

    it('toggle=true: event POJAWIA SIĘ w domyślnym search obok fact/document', async () => {
      const marker = 'eventtoggleenabledmarker2';
      const seeded = await seedEvent(`Zdarzenie ${marker}`, new Date(), projectToggle.projectId);
      const ctxWithToggle: ProjectContext = { ...projectToggle, includeEventsInDefaultSearch: true };

      const results = await memory.search({ query: marker }, ctxWithToggle);
      expect(results.some((r) => r.id === seeded.id)).toBe(true);
    });

    it('izolacja: toggle=true w projekcie A nie ujawnia eventów A w domyślnym search projektu B', async () => {
      const marker = 'eventtoggleisolationmarker3';
      const seededA = await seedEvent(`Zdarzenie A ${marker}`, new Date(), projectToggle.projectId);
      const ctxAWithToggle: ProjectContext = { ...projectToggle, includeEventsInDefaultSearch: true };

      // projectB (top-level beforeAll) — cudzy projekt, BEZ togglea — nie widzi eventu A wcale
      // (scope), niezależnie od tego że projekt A ma toggle włączony.
      const resultsFromB = await memory.search({ query: marker }, projectB);
      expect(resultsFromB.some((r) => r.id === seededA.id)).toBe(false);

      // sanity: ten sam event faktycznie widoczny z własnego kontekstu z włączonym togglem.
      const resultsFromA = await memory.search({ query: marker }, ctxAWithToggle);
      expect(resultsFromA.some((r) => r.id === seededA.id)).toBe(true);
    });
  });

  describe('search — age-decay dla kind=event (roadmap v1.2, "kind=event episodic")', () => {
    let projectDecay: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-event-decay');
      projectDecay = {
        projectId: created.project.id,
        projectName: created.project.name,
        includeEventsInDefaultSearch: true,
      };
    });

    async function seedEvent(header: string, eventTime: Date) {
      const [row] = await db
        .insert(schema.memories)
        .values({
          id: generateId(ID_PREFIX.memory),
          header,
          body: header,
          kind: 'event',
          tags: [],
          scope: 'project',
          projectId: projectDecay.projectId,
          status: 'approved',
          source: 'human',
          approvedAt: new Date(),
          eventTime,
        })
        .returning();
      return row;
    }

    it('event świeży rankuje wyżej niż event ~2 half-life stary, dla tego samego zapytania', async () => {
      const marker = 'eventdecayorderingmarker1';
      const fresh = await seedEvent(`Zdarzenie swieze ${marker}`, new Date());
      const stale = await seedEvent(`Zdarzenie stare ${marker}`, new Date(Date.now() - 2 * 30 * 86_400_000));

      const results = await memory.search({ query: marker }, projectDecay);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(fresh.id);
      expect(ids).toContain(stale.id);
      expect(ids.indexOf(fresh.id)).toBeLessThan(ids.indexOf(stale.id));
    });

    it('event z przyszłą datą nie jest karany — bez konkurencji rankingowej score = DOKŁADNIE 1/(RRF_K+1), jak decayFactor=1', async () => {
      const marker = 'eventdecayfuturemarker2';
      await seedEvent(`Zdarzenie przyszle ${marker}`, new Date(Date.now() + 10 * 86_400_000));

      const results = await memory.search({ query: marker }, projectDecay);
      expect(results.length).toBe(1);
      // Gdyby clamp nie działał, faktor>1 (ujemny wiek) PODNIÓSŁBY score powyżej 1/(RRF_K+1) — clamp
      // do 1 gwarantuje dokładnie tę samą wartość co dla age=0 (regression-guard test niżej).
      expect(results[0].score).toBeCloseTo(1 / (config.get('RRF_K') + 1), 10);
    });

    it('regression guard: fact bez eventów w zakresie ma DOKŁADNIE score = 1/(RRF_K+1) (decayFactor=1, zero wpływu)', async () => {
      const marker = 'eventdecayregressionmarker3';
      await memory.devSeedApproved({
        header: `Fakt regresyjny ${marker}`,
        body: 'Trescy bez konkurencji rankingowej dla tego markera.',
        kind: 'fact',
        scope: 'project',
        projectId: projectDecay.projectId,
      });

      const results = await memory.search({ query: marker }, projectDecay);
      expect(results.length).toBe(1);
      expect(results[0].score).toBeCloseTo(1 / (config.get('RRF_K') + 1), 10);
    });
  });

  describe('search — 1-hop graph boost (roadmap v1.2, "memory-relations + 1-hop graph boost")', () => {
    let projectBoost: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-graph-boost');
      projectBoost = { projectId: created.project.id, projectName: created.project.name };
    });

    async function seedRelation(fromId: string, toId: string, projectId: string): Promise<void> {
      await db.insert(schema.memoryRelations).values({
        id: generateId(ID_PREFIX.relation),
        fromMemoryId: fromId,
        toMemoryId: toId,
        type: 'follows',
        projectId,
        source: 'human',
      });
    }

    it('boost ×(1+w) na krawędzi w sfuzjowanym zbiorze podnosi score i może poprawić ranking względem niepowiązanego sąsiada', async () => {
      const marker = 'graphboostorderingmarker1';
      // Provider zawsze down -> ramię wektorowe puste, ranking WYŁĄCZNIE z ts_rank FTS
      // (deterministyczne, jak w istniejących testach hybrid/decay powyżej).
      const throwingProvider = new StubEmbeddingProvider('graph-boost-ordering-throwing');
      throwingProvider.throwOnEmbed = true;

      const { memory: seedMemory } = buildMemoryService(throwingProvider);
      // A: marker 4x (header 3x + body 1x) -> najwyższy ts_rank, rank 1.
      const a = await seedMemory.devSeedApproved({
        header: `${marker} ${marker} ${marker}`,
        body: `${marker} czwarty raz w tresci.`,
        kind: 'fact',
        scope: 'project',
        projectId: projectBoost.projectId,
      });
      // C: marker 2x, BEZ żadnej krawędzi -> rank 2, kontrolny (nietknięty boostem).
      const c = await seedMemory.devSeedApproved({
        header: `Fakt ${marker} ${marker}`,
        body: 'Fakt kontrolny, bez powiazan grafowych.',
        kind: 'fact',
        scope: 'project',
        projectId: projectBoost.projectId,
      });
      // B: marker 1x -> najsłabszy ts_rank (rank 3), POWIĄZANY z A.
      const b = await seedMemory.devSeedApproved({
        header: `Fakt B ${marker}`,
        body: 'Powiazany z A przez relacje follows.',
        kind: 'fact',
        scope: 'project',
        projectId: projectBoost.projectId,
      });
      await seedRelation(a.id, b.id, projectBoost.projectId);

      const { memory: baselineMemory } = buildMemoryService(throwingProvider, { GRAPH_BOOST_WEIGHT: 0 });
      const baseline = await baselineMemory.search({ query: marker }, projectBoost);
      expect(baseline.map((r) => r.id)).toEqual([a.id, c.id, b.id]); // czysty ts_rank, bez boosta

      // w=1 -> factor=1+1=2, łatwe do zweryfikowania dokładną wartością.
      const { memory: boostMemory } = buildMemoryService(throwingProvider, { GRAPH_BOOST_WEIGHT: 1 });
      const boosted = await boostMemory.search({ query: marker }, projectBoost);
      const boostedIds = boosted.map((r) => r.id);
      // B (boostowany) wyprzedza C (niepowiązany) mimo słabszego ts_rank -> ranking się poprawia.
      expect(boostedIds.indexOf(b.id)).toBeLessThan(boostedIds.indexOf(c.id));

      const baseA = baseline.find((r) => r.id === a.id)!.score;
      const baseB = baseline.find((r) => r.id === b.id)!.score;
      const baseC = baseline.find((r) => r.id === c.id)!.score;
      expect(boosted.find((r) => r.id === a.id)!.score).toBeCloseTo(baseA * 2, 10); // A powiazany -> ×(1+w)
      expect(boosted.find((r) => r.id === b.id)!.score).toBeCloseTo(baseB * 2, 10); // B powiazany -> ×(1+w)
      expect(boosted.find((r) => r.id === c.id)!.score).toBeCloseTo(baseC, 10); // C niepowiazany -> bez zmian
    });

    it('weight=0 -> score dokładnie 1/(RRF_K+rank), krawędź między oboma trafionymi memories BEZ WPŁYWU (knob wyłącza efekt)', async () => {
      const marker = 'graphboostdisabledmarker3';
      const throwingProvider = new StubEmbeddingProvider('graph-boost-disabled-throwing');
      throwingProvider.throwOnEmbed = true;
      const { memory: zeroWeightMemory, config: zeroConfig } = buildMemoryService(throwingProvider, {
        GRAPH_BOOST_WEIGHT: 0,
      });

      // X: marker 2x -> rank 1. Y: marker 1x -> rank 2. Powiązane krawędzią.
      const x = await zeroWeightMemory.devSeedApproved({
        header: `${marker} ${marker}`,
        body: 'Fakt X.',
        kind: 'fact',
        scope: 'project',
        projectId: projectBoost.projectId,
      });
      const y = await zeroWeightMemory.devSeedApproved({
        header: `Fakt Y ${marker}`,
        body: 'Powiazany z X.',
        kind: 'fact',
        scope: 'project',
        projectId: projectBoost.projectId,
      });
      await seedRelation(x.id, y.id, projectBoost.projectId);

      const results = await zeroWeightMemory.search({ query: marker }, projectBoost);
      const scoreX = results.find((r) => r.id === x.id)!.score;
      const scoreY = results.find((r) => r.id === y.id)!.score;
      const k = zeroConfig.get('RRF_K');
      expect(scoreX).toBeCloseTo(1 / (k + 1), 10);
      expect(scoreY).toBeCloseTo(1 / (k + 2), 10);
    });

    it('re-rank only: pamięć POZA sfuzjowanym zbiorem (nietrafiona przez query) nigdy nie zostaje wstrzyknięta mimo krawędzi do trafionej pamięci', async () => {
      const marker = 'graphboostinjectionmarker2';
      const throwingProvider = new StubEmbeddingProvider('graph-boost-injection-throwing');
      throwingProvider.throwOnEmbed = true;
      // Maksymalna dopuszczalna waga (sufit `.max(1)` w `envSchema` — §config/env.ts): re-rank-only
      // jest własnością ZBIORU, nie skali, więc wielkość wagi i tak nie decyduje o tym, czy `outside`
      // wejdzie do wyników. Bierzemy sufit, żeby test pokazywał, że nawet przy najsilniejszym
      // dopuszczalnym boostcie nic się nie wstrzykuje.
      const { memory: injMemory } = buildMemoryService(throwingProvider, { GRAPH_BOOST_WEIGHT: 1 });

      const hit = await injMemory.devSeedApproved({
        header: `Trafiony fakt ${marker}`,
        body: marker,
        kind: 'fact',
        scope: 'project',
        projectId: projectBoost.projectId,
      });
      const outside = await injMemory.devSeedApproved({
        header: 'Fakt zupelnie niepowiazany tresciowo',
        body: 'Bez zadnego zwiazku z zapytaniem wyszukiwania.',
        kind: 'fact',
        scope: 'project',
        projectId: projectBoost.projectId,
      });
      await seedRelation(hit.id, outside.id, projectBoost.projectId);

      const results = await injMemory.search({ query: marker }, projectBoost);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(hit.id);
      // `fetchInSetEdges` wymaga OBU końców w fused -> `outside` (poza fused) nigdy nie wchodzi.
      expect(ids).not.toContain(outside.id);
    });
  });

  describe('save — staged embedding (Faza 3, best-effort fail-open)', () => {
    let projectS: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-save-staging');
      projectS = { projectId: created.project.id, projectName: created.project.name };
    });

    async function proposalIdFor(memoryId: string, projectId: string): Promise<string> {
      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectId));
      const match = rows.find((p) => (p.payload as { memoryId: string }).memoryId === memoryId);
      if (!match) throw new Error(`Brak proposala dla memoryId=${memoryId}`);
      return match.id;
    }

    it('healthy provider: save zapisuje staging_embeddings dla nowego proposala', async () => {
      const healthyProvider = new StubEmbeddingProvider('save-staging-model');
      const { memory: healthyMemory } = buildMemoryService(healthyProvider);

      const res = await healthyMemory.save(
        { header: 'Fakt ze staged embeddingiem', body: 'Tresc do zaembeddowania przy save.' },
        projectS,
      );
      expect(res.status).toBe('pending');

      const propId = await proposalIdFor(res.id, projectS.projectId);
      const staged = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, propId));

      expect(staged.length).toBeGreaterThan(0);
      expect(staged[0].embeddingModel).toBe('save-staging-model');
      expect(staged[0].chunkText).toContain('Fakt ze staged embeddingiem');
    });

    it('healthy provider, kind=document: staging_embeddings dostaje header dopisany do KAŻDEGO chunku (chunker document, §6 tech-stack)', async () => {
      const healthyProvider = new StubEmbeddingProvider('save-staging-document-model');
      const { memory: healthyMemory } = buildMemoryService(healthyProvider);

      const res = await healthyMemory.save(
        { header: 'Dokument ze staged embeddingiem', body: 'Tresc dokumentu do zaembeddowania przy save.', kind: 'document' },
        projectS,
      );
      expect(res.status).toBe('pending');

      const propId = await proposalIdFor(res.id, projectS.projectId);
      const staged = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, propId));

      expect(staged.length).toBeGreaterThan(0);
      expect(staged[0].embeddingModel).toBe('save-staging-document-model');
      for (const row of staged) {
        expect(row.chunkText).toContain('Dokument ze staged embeddingiem');
      }
    });

    it('provider down: save i tak tworzy proposal pending, ale BEZ wiersza staging_embeddings', async () => {
      const downProvider = new StubEmbeddingProvider('save-staging-down-model');
      downProvider.throwOnEmbed = true;
      const { memory: downMemory } = buildMemoryService(downProvider);

      const res = await downMemory.save(
        { header: 'Fakt bez staged embeddingu', body: 'Provider padniety przy tym save.' },
        projectS,
      );
      expect(res.status).toBe('pending');

      const propId = await proposalIdFor(res.id, projectS.projectId);
      const staged = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, propId));
      expect(staged.length).toBe(0);
    });
  });

  describe('roadmap v1.3 — kind=event przez agenta', () => {
    let projectEvent: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-event-v13');
      projectEvent = { projectId: created.project.id, projectName: created.project.name };
    });

    async function proposalFor(memoryId: string, projectId: string) {
      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectId));
      const match = rows.find((p) => (p.payload as { memoryId: string }).memoryId === memoryId);
      if (!match) throw new Error(`Brak proposala dla memoryId=${memoryId}`);
      return match;
    }

    it('happy: save({kind:"event", eventTime}) -> pending, id ~ ^mem_, proposals.payload niesie eventTime jako ISO string', async () => {
      const res = await memory.save(
        {
          header: 'Deploy na prod v1.3',
          body: 'Wdrozenie kind=event przez agenta.',
          kind: 'event',
          eventTime: '2026-03-01T09:00:00Z',
        },
        projectEvent,
      );
      expect(res.status).toBe('pending');
      expect(res.id).toMatch(/^mem_/);

      const proposalRow = await proposalFor(res.id, projectEvent.projectId);
      expect(proposalRow.type).toBe('create');
      expect(proposalRow.origin).toBe('agent');
      const payload = proposalRow.payload as { kind: string; eventTime?: string };
      expect(payload.kind).toBe('event');
      expect(payload.eventTime).toBe('2026-03-01T09:00:00.000Z');
    });

    it('po ProposalsService.approve(...) -> wiersz w memories ma kind=event, source=agent, event_time == podany', async () => {
      const provider = new StubEmbeddingProvider('event-approve-model');
      const { memory: eventMemory } = buildMemoryService(provider);
      const proposalsService = new ProposalsService(db, config, audit, new EmbeddingService(provider, config));

      const res = await eventMemory.save(
        {
          header: 'Incydent do zatwierdzenia',
          body: 'Tresc incydentu do materializacji.',
          kind: 'event',
          eventTime: '2026-04-15T12:00:00Z',
        },
        projectEvent,
      );
      const proposalRow = await proposalFor(res.id, projectEvent.projectId);

      const approveResult = await proposalsService.approve(proposalRow.id, { actor: 'tester' });
      expect(approveResult.materializedId).toBe(res.id);

      const [memRow] = await db.select().from(schema.memories).where(eq(schema.memories.id, res.id));
      expect(memRow.kind).toBe('event');
      expect(memRow.source).toBe('agent');
      expect(memRow.eventTime?.toISOString()).toBe('2026-04-15T12:00:00.000Z');
    });

    it('save({kind:"event"}) bez eventTime -> validation_error, zero nowych wierszy w proposals', async () => {
      const before = await db.select().from(proposals).where(eq(proposals.projectId, projectEvent.projectId));

      await expect(
        memory.save({ header: 'Event bez daty', body: 'Tresc.', kind: 'event' }, projectEvent),
      ).rejects.toMatchObject({ code: 'validation_error' });

      const after = await db.select().from(proposals).where(eq(proposals.projectId, projectEvent.projectId));
      expect(after.length).toBe(before.length);
    });

    it('save({kind:"event", eventTime:"nie-data"}) -> validation_error', async () => {
      await expect(
        memory.save(
          { header: 'Event ze zla data', body: 'Tresc.', kind: 'event', eventTime: 'nie-data' },
          projectEvent,
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('save({kind:"fact", eventTime}) -> validation_error (decyzja #6 — event_time ma sens tylko dla kind=event)', async () => {
      await expect(
        memory.save(
          {
            header: 'Fakt z niepotrzebnym eventTime',
            body: 'Tresc.',
            kind: 'fact',
            eventTime: '2026-03-01T09:00:00Z',
          },
          projectEvent,
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('ta sama tresc, dwa rozne eventTime -> dwa osobne pending (NIE duplicate_pending)', async () => {
      const header = 'Dedup event-aware — rozne eventTime';
      const body = 'Identyczna tresc, rozne czasy zdarzenia.';

      const first = await memory.save(
        { header, body, kind: 'event', eventTime: '2026-05-01T08:00:00Z' },
        projectEvent,
      );
      expect(first.status).toBe('pending');

      const second = await memory.save(
        { header, body, kind: 'event', eventTime: '2026-05-02T08:00:00Z' },
        projectEvent,
      );
      expect(second.status).toBe('pending'); // NIE duplicate_pending mimo identycznego header+body+kind
      expect(second.id).not.toBe(first.id);
    });

    it('ta sama tresc, ten sam eventTime, drugi raz -> duplicate_pending', async () => {
      const header = 'Dedup event-aware — ten sam eventTime';
      const body = 'Identyczna tresc, ten sam czas zdarzenia.';
      const eventTime = '2026-06-01T08:00:00Z';

      const first = await memory.save({ header, body, kind: 'event', eventTime }, projectEvent);
      expect(first.status).toBe('pending');

      const second = await memory.save({ header, body, kind: 'event', eventTime }, projectEvent);
      expect(second.status).toBe('duplicate_pending');
      expect(second.id).toMatch(/^prop_/);
    });

    it('save({kind:"event", eventTime, supersedes: <id faktu>}) -> validation_error z komunikatem o human-only', async () => {
      const targetFact = await memory.devSeedApproved({
        header: 'Fakt istniejacy do proby supersede eventem',
        body: 'Tresc.',
        kind: 'fact',
        scope: 'project',
        projectId: projectEvent.projectId,
      });

      await expect(
        memory.save(
          {
            header: 'Proba supersede faktu przez event',
            body: 'Tresc.',
            kind: 'event',
            eventTime: '2026-03-01T09:00:00Z',
            supersedes: targetFact.id,
          },
          projectEvent,
        ),
      ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('human-only') });
    });

    it('sekret w body eventu -> secret_blocked, zero proposali (mirror :268)', async () => {
      const before = await db.select().from(proposals).where(eq(proposals.projectId, projectEvent.projectId));

      await expect(
        memory.save(
          {
            header: 'Incydent z sekretem',
            body: 'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP',
            kind: 'event',
            eventTime: '2026-03-01T09:00:00Z',
          },
          projectEvent,
        ),
      ).rejects.toMatchObject({ code: 'secret_blocked' });

      const after = await db.select().from(proposals).where(eq(proposals.projectId, projectEvent.projectId));
      expect(after.length).toBe(before.length);
    });

    it('body ponad BODY_MAX_EVENT -> validation_error', async () => {
      const { memory: tightMemory, config: tightConfig } = buildMemoryService(new StubEmbeddingProvider('event-body-limit'), {
        BODY_MAX_EVENT: 10,
      });
      expect(tightConfig.get('BODY_MAX_EVENT')).toBe(10);

      await expect(
        tightMemory.save(
          {
            header: 'Event za duzy',
            body: 'a'.repeat(11),
            kind: 'event',
            eventTime: '2026-03-01T09:00:00Z',
          },
          projectEvent,
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
  });
});
