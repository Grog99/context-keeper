import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, arrayOverlaps, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { ToolError } from '../src/common/errors';
import { generateId, ID_PREFIX } from '../src/common/ids';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import {
  auditLog,
  EMBEDDING_DIM,
  embeddings,
  memories,
  memoryRelations,
  projects as projectsTable,
  proposals,
  revisions,
  stagingEmbeddings,
  type MemoryRow,
  type ProposalRow,
} from '../src/db/schema';
import type { MemoryKind } from '../src/db/schema/enums';
import { chunk } from '../src/embeddings/chunker';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { MemoryAdminService } from '../src/memory/memory-admin.service';
import { MemoryService } from '../src/memory/memory.service';
import type { ProjectContext, ProjectsService } from '../src/projects/projects.service';
import { AutoApprovalRefusedError, autoModeActor } from '../src/proposals/auto-mode';
import { ProposalError } from '../src/proposals/proposals.errors';
import { ProposalsService } from '../src/proposals/proposals.service';
import { UsageService } from '../src/usage/usage.service';
import { StubEmbeddingProvider } from './helpers/fakes';
import { buildProjectsService } from './helpers/services';

/** Wektor w płaszczyźnie osi (a, b) obrócony o kąt `t` (a, b < FIRST_FREE_AXIS — poza osiami stuba). */
function vec(a: number, b: number, t = 0): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[a] = Math.cos(t);
  v[b] = Math.sin(t);
  return v;
}

function angleFor(distance: number): number {
  return Math.acos(1 - distance);
}

const FIRST_FREE_AXIS = 10;

function register(
  provider: StubEmbeddingProvider,
  content: { kind: MemoryKind; header: string; body: string },
  vectors: number[][],
): void {
  const chunks = chunk(content.kind, content.header, content.body, []);
  expect(chunks.length).toBe(vectors.length);
  chunks.forEach((c, i) => provider.register(c.text, vectors[i]));
}

const SAVE_BUDGET_MS = 10_000;

describe('Auto mode — ścieżka zapisu i bezpieczniki (A2, integration, testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let audit: AuditService;
  let counter = 0;

  function buildServices(provider: EmbeddingProvider, envOverrides: Record<string, unknown> = {}) {
    const config = new AppConfigService(
      envSchema.parse({
        DATABASE_URL: 'postgres://unused',
        NEAR_DUPLICATE_DISTANCE: 0.1,
        EMBEDDING_SAVE_TIMEOUT_MS: SAVE_BUDGET_MS,
        ...envOverrides,
      }),
    );
    const embeddingService = new EmbeddingService(provider, config);
    const proposalsService = new ProposalsService(db, config, audit, embeddingService);
    return {
      memoryService: new MemoryService(db, config, audit, embeddingService, new UsageService(db), proposalsService),
      proposalsService,
      memoryAdmin: new MemoryAdminService(db, config, audit, embeddingService),
    };
  }

  /** Świeży projekt (domyślnie z auto mode i limitem 50) + unikalny model providera per test. */
  async function freshCase(opts: { autoMode?: boolean; limit?: number; env?: Record<string, unknown> } = {}) {
    counter += 1;
    const created = await projects.createProject(`auto-mode-${counter}`);
    const autoMode = opts.autoMode ?? true;
    await projects.updateProject(created.project.id, {
      autoMode,
      ...(opts.limit !== undefined ? { autoModeDailyLimit: opts.limit } : {}),
    });
    const ctx: ProjectContext = {
      projectId: created.project.id,
      projectName: created.project.name,
      autoMode,
      autoModeDailyLimit: opts.limit ?? 50,
    };
    // Teksty zarejestrowane dostają wskazany wektor, KAŻDY inny tekst — świeżą, parami ortogonalną oś jednostkową od
    // `FIRST_FREE_AXIS` (dystans 1 do wszystkiego), więc kolejne zapisy o różnej treści nigdy nie są względem siebie
    // prawie-duplikatami (w odróżnieniu od jednego wspólnego „FAR" z testów A1).
    const provider = new StubEmbeddingProvider(`auto-mode-model-${counter}`, { freshAxisFrom: FIRST_FREE_AXIS });
    return { ctx, provider, model: provider.model, ...buildServices(provider, opts.env) };
  }

  /** Zatwierdzona pamięć `source='human'` z autorytatywnym wektorem (bezpośredni insert). */
  async function seedApproved(p: {
    projectId: string;
    header: string;
    body: string;
    vector: number[];
    model: string;
    source?: 'human' | 'agent';
  }): Promise<MemoryRow> {
    const [row] = await db
      .insert(memories)
      .values({
        id: generateId(ID_PREFIX.memory),
        header: p.header,
        body: p.body,
        kind: 'fact',
        tags: [],
        scope: 'project',
        projectId: p.projectId,
        status: 'approved',
        source: p.source ?? 'human',
        version: 0,
        approvedAt: new Date(),
      })
      .returning();
    const [c] = chunk('fact', p.header, p.body, []);
    await db.insert(embeddings).values({
      id: generateId(ID_PREFIX.embedding),
      memoryId: row.id,
      chunkIndex: c.index,
      chunkText: c.text,
      embeddingModel: p.model,
      vector: p.vector,
    });
    return row;
  }

  async function proposalForMemory(memoryId: string): Promise<ProposalRow> {
    const rows = await db.select().from(proposals);
    const match = rows.find((r) => (r.payload as { memoryId?: string }).memoryId === memoryId);
    if (!match) throw new Error(`Brak proposala dla memoryId=${memoryId}`);
    return match;
  }

  async function getProposal(id: string): Promise<ProposalRow> {
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    return row;
  }

  async function getMemory(id: string): Promise<MemoryRow | undefined> {
    const [row] = await db.select().from(memories).where(eq(memories.id, id)).limit(1);
    return row;
  }

  async function proposalCount(projectId: string): Promise<number> {
    return (await db.select().from(proposals).where(eq(proposals.projectId, projectId))).length;
  }

  async function auditEntries(eventType: 'proposal_created' | 'proposal_approved' | 'relation_created', affectedId: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.eventType, eventType), arrayOverlaps(auditLog.affectedIds, [affectedId])));
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    projects = buildProjectsService(db, new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' })));
    audit = new AuditService(db);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('auto-akceptacja w limicie', () => {
    it('create fact bez podobnych → {id: mem_, approved}; get/search widzą od razu; ślad jak akceptacja człowieka', async () => {
      const { ctx, memoryService } = await freshCase();

      const res = await memoryService.save({ header: 'Auto fakt alfa', body: 'Treść auto faktu alfa.' }, ctx);

      expect(res.status).toBe('approved');
      expect(res.id).toMatch(/^mem_/);
      const got = await memoryService.get(res.id, ctx);
      expect(got.body).toBe('Treść auto faktu alfa.');
      const hits = await memoryService.search({ query: 'alfa' }, ctx);
      expect(hits.map((h) => h.id)).toContain(res.id);

      const mem = (await getMemory(res.id))!;
      expect(mem.source).toBe('agent');
      expect(mem.status).toBe('approved');
      expect(mem.autoApprovedAt).not.toBeNull();

      const prop = await proposalForMemory(res.id);
      expect(prop.status).toBe('approved');
      expect(prop.autoApprovedAt).not.toBeNull();
      expect(prop.autoHoldReasons).toBeNull();

      const created = await auditEntries('proposal_created', res.id);
      expect(created.map((e) => e.actor)).toEqual([`agent:${ctx.projectId}`]);
      const approved = await auditEntries('proposal_approved', res.id);
      expect(approved).toHaveLength(1);
      expect(approved[0].actor).toBe(autoModeActor(ctx.projectId));
      expect(approved[0].actor.startsWith('human-')).toBe(false);
      expect((approved[0].metadata as { auto?: boolean }).auto).toBe(true);

      const revs = await db.select().from(revisions).where(eq(revisions.memoryId, res.id));
      expect(revs.map((r) => [r.action, r.actor])).toEqual([['created', autoModeActor(ctx.projectId)]]);

      // Promocja embeddingu jak przy akceptacji człowieka: authoritative są, staging posprzątany.
      const emb = await db.select().from(embeddings).where(eq(embeddings.memoryId, res.id));
      expect(emb.length).toBeGreaterThan(0);
      const staging = await db.select().from(stagingEmbeddings).where(eq(stagingEmbeddings.proposalId, prop.id));
      expect(staging).toHaveLength(0);
    });

    it('document bez podobnych → approved', async () => {
      const { ctx, memoryService } = await freshCase();
      const res = await memoryService.save(
        { header: 'Dokument auto', body: 'Samodzielny tekst referencyjny.', kind: 'document' },
        ctx,
      );
      expect(res.status).toBe('approved');
      expect((await getMemory(res.id))!.kind).toBe('document');
    });

    it('event w limicie → approved (bez bezpiecznika (a)), z event_time', async () => {
      const { ctx, memoryService } = await freshCase();
      const res = await memoryService.save(
        { header: 'Deploy auto', body: 'Wdrożono wersję.', kind: 'event', eventTime: '2026-01-02T03:04:05Z' },
        ctx,
      );
      expect(res.status).toBe('approved');
      const mem = (await getMemory(res.id))!;
      expect(mem.kind).toBe('event');
      expect(mem.eventTime?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
      expect(mem.autoApprovedAt).not.toBeNull();
    });

    it('supersedes na cel agenta bez human_edit → {id: cel, approved}; nowa wersja, znacznik auto', async () => {
      const { ctx, memoryService } = await freshCase();
      const target = await memoryService.save({ header: 'Cel korekty', body: 'Stara treść celu.' }, ctx);
      expect(target.status).toBe('approved');

      const res = await memoryService.save(
        { header: 'Cel korekty', body: 'Poprawiona treść celu.', supersedes: target.id },
        ctx,
      );

      expect(res).toEqual({ id: target.id, status: 'approved' });
      const mem = (await getMemory(target.id))!;
      expect(mem.version).toBe(1);
      expect(mem.body).toBe('Poprawiona treść celu.');
      expect(mem.autoApprovedAt).not.toBeNull();
      const revs = await db.select().from(revisions).where(eq(revisions.memoryId, target.id));
      expect(revs.map((r) => r.action).sort()).toEqual(['created', 'edited']);
      const emb = await db.select().from(embeddings).where(eq(embeddings.memoryId, target.id));
      expect(emb.map((e) => e.chunkText).join(' ')).toContain('Poprawiona treść celu.');
    });

    it('relacje z auto-zaakceptowanego zapisu istnieją od razu, audyt z aktorem maszynowym', async () => {
      const { ctx, memoryService } = await freshCase();
      const a = await memoryService.save({ header: 'Kontekst A', body: 'Fakt kontekstowy.' }, ctx);
      const b = await memoryService.save(
        { header: 'Fakt B', body: 'Fakt z relacją.', relations: [{ type: 'context_for', targetId: a.id }] },
        ctx,
      );
      expect(b.status).toBe('approved');

      const rels = await db.select().from(memoryRelations).where(eq(memoryRelations.fromMemoryId, b.id));
      expect(rels.map((r) => [r.toMemoryId, r.type])).toEqual([[a.id, 'context_for']]);
      const evts = await auditEntries('relation_created', b.id);
      expect(evts).toHaveLength(1);
      expect(evts[0].actor).toBe(autoModeActor(ctx.projectId));
    });
  });

  describe('auto mode wyłączony i zapisy redundantne — bez zmian', () => {
    it('autoMode=false → pending, id = id pamięci z payloadu, kolumny auto NULL', async () => {
      const { ctx, memoryService } = await freshCase({ autoMode: false });
      const res = await memoryService.save({ header: 'Bez auto', body: 'Czeka w kolejce.' }, ctx);

      expect(res.status).toBe('pending');
      expect(res.id).toMatch(/^mem_/);
      expect(Object.keys(res).sort()).toEqual(['id', 'status']);
      const prop = await proposalForMemory(res.id);
      expect(prop.status).toBe('pending');
      expect(prop.autoApprovedAt).toBeNull();
      expect(prop.autoHoldReasons).toBeNull();
      expect(await getMemory(res.id)).toBeUndefined();
    });

    it('kontekst bez pól auto (stary, ręcznie budowany) → pending', async () => {
      const { ctx, memoryService } = await freshCase();
      const res = await memoryService.save(
        { header: 'Stary ctx', body: 'Kontekst bez autoMode.' },
        { projectId: ctx.projectId, projectName: ctx.projectName },
      );
      expect(res.status).toBe('pending');
    });

    it('duplicate_pending / already_exists / secret_blocked / validation_error / not_found — jak przy wyłączonym', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      // duplicate_pending: najpierw zawrócony (near_duplicate) zapis, potem identyczny.
      await seedApproved({ projectId: ctx.projectId, header: 'Baza dedup', body: 'Baza.', vector: vec(0, 1), model });
      register(provider, { kind: 'fact', header: 'Powtórka auto', body: 'Powtarzany zapis.' }, [
        vec(0, 1, angleFor(0.02)),
      ]);
      const held = await memoryService.save({ header: 'Powtórka auto', body: 'Powtarzany zapis.' }, ctx);
      expect(held.status).toBe('pending');
      const heldProposal = await proposalForMemory(held.id);
      const before = await proposalCount(ctx.projectId);
      const dup = await memoryService.save({ header: 'Powtórka auto', body: 'Powtarzany zapis.' }, ctx);
      expect(dup).toEqual({ id: heldProposal.id, status: 'duplicate_pending' });

      // already_exists: najpierw auto-zatwierdzony, potem identyczny.
      const first = await memoryService.save({ header: 'Raz', body: 'Tylko jedna kopia.' }, ctx);
      expect(first.status).toBe('approved');
      const mid = await proposalCount(ctx.projectId);
      const again = await memoryService.save({ header: 'Raz', body: 'Tylko jedna kopia.' }, ctx);
      expect(again).toEqual({ id: first.id, status: 'already_exists' });

      // secret_blocked / validation_error / not_found rzucają ToolError, bez nowego proposala.
      const secret = memoryService.save(
        { header: 'Sekret', body: 'klucz AKIAIOSFODNN7EXAMPLE tutaj' },
        ctx,
      );
      await expect(secret).rejects.toMatchObject({ code: 'secret_blocked' });
      await expect(memoryService.save({ header: '   ', body: 'x' }, ctx)).rejects.toBeInstanceOf(ToolError);
      await expect(
        memoryService.save({ header: 'Korekta', body: 'Treść.', supersedes: 'mem_doesnotexist' }, ctx),
      ).rejects.toMatchObject({ code: 'not_found' });

      expect(await proposalCount(ctx.projectId)).toBe(mid);
      expect(mid).toBe(before + 1); // tylko proposal „Raz"
    });

    it('approve({auto}) odmawia propozycji nocnego joba i create_project (defence-in-depth)', async () => {
      const { ctx, proposalsService } = await freshCase();
      const nightlyId = generateId(ID_PREFIX.proposal);
      await db.insert(proposals).values({
        id: nightlyId,
        type: 'delete',
        origin: 'nightly',
        status: 'pending',
        payload: { memoryId: 'mem_nope' },
        affectedIds: [],
        baseVersions: {},
        scope: 'project',
        projectId: ctx.projectId,
      });
      await expect(
        proposalsService.approve(nightlyId, { actor: autoModeActor(ctx.projectId), auto: true }),
      ).rejects.toMatchObject({ code: 'validation_error' });

      const createProjectId = generateId(ID_PREFIX.proposal);
      await db.insert(proposals).values({
        id: createProjectId,
        type: 'create_project',
        origin: 'agent',
        status: 'pending',
        payload: { name: 'Nowy', slug: `auto-new-${counter}` },
        affectedIds: [],
        baseVersions: {},
        scope: 'global',
        projectId: null,
      });
      const err = await proposalsService
        .approve(createProjectId, { actor: autoModeActor(ctx.projectId), auto: true })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProposalError);
      expect((await getProposal(createProjectId)).status).toBe('pending');
      expect((await getProposal(nightlyId)).status).toBe('pending');
    });
  });

  describe('bezpieczniki → pending z powodem', () => {
    it('(a) bliski zatwierdzony fakt → pending, near_duplicate, brak pamięci', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      await seedApproved({ projectId: ctx.projectId, header: 'Fakt X', body: 'Klient używa PG 15.', vector: vec(0, 1), model });
      register(provider, { kind: 'fact', header: 'Fakt X prim', body: 'Klient korzysta z PG 15.' }, [
        vec(0, 1, angleFor(0.02)),
      ]);

      const res = await memoryService.save({ header: 'Fakt X prim', body: 'Klient korzysta z PG 15.' }, ctx);

      expect(res.status).toBe('pending');
      expect(res.id).toMatch(/^mem_/);
      const prop = await proposalForMemory(res.id);
      expect(prop.status).toBe('pending');
      expect(prop.autoHoldReasons).toEqual(['near_duplicate']);
      expect(prop.autoApprovedAt).toBeNull();
      expect(await getMemory(res.id)).toBeUndefined();
    });

    it('(a′) provider rzuca → pending, not_computed; propozycja istnieje', async () => {
      const { ctx, provider, memoryService } = await freshCase();
      provider.throwOnEmbed = true;
      const res = await memoryService.save({ header: 'Bez wektora', body: 'Provider leży.' }, ctx);
      expect(res.status).toBe('pending');
      expect((await proposalForMemory(res.id)).autoHoldReasons).toEqual(['not_computed']);
    });

    it('(a′) provider wolniejszy niż budżet → pending w budżecie, not_computed', async () => {
      const { ctx, provider, memoryService } = await freshCase({ env: { EMBEDDING_SAVE_TIMEOUT_MS: 200 } });
      provider.delayMs = 1000;
      const startedAt = Date.now();
      const res = await memoryService.save({ header: 'Wolny provider', body: 'Za wolno.' }, ctx);
      expect(Date.now() - startedAt).toBeLessThan(800);
      expect(res.status).toBe('pending');
      expect((await proposalForMemory(res.id)).autoHoldReasons).toEqual(['not_computed']);
    });

    it('D1: event przy padniętym providerze → pending, not_computed (nie powstaje pamięć bez wektora)', async () => {
      const { ctx, provider, memoryService } = await freshCase();
      provider.throwOnEmbed = true;
      const res = await memoryService.save(
        { header: 'Incydent', body: 'Coś się stało.', kind: 'event', eventTime: '2026-02-03T00:00:00Z' },
        ctx,
      );
      expect(res.status).toBe('pending');
      expect((await proposalForMemory(res.id)).autoHoldReasons).toEqual(['not_computed']);
      expect(await getMemory(res.id)).toBeUndefined();
    });

    it('D1: supersedes przy padniętym providerze → pending, not_computed; wektory celu nietknięte', async () => {
      const { ctx, provider, memoryService } = await freshCase();
      const target = await memoryService.save({ header: 'Cel D1', body: 'Treść celu D1.' }, ctx);
      expect(target.status).toBe('approved');
      const embBefore = await db.select().from(embeddings).where(eq(embeddings.memoryId, target.id));
      expect(embBefore.length).toBeGreaterThan(0);

      provider.throwOnEmbed = true;
      const res = await memoryService.save(
        { header: 'Cel D1', body: 'Poprawka D1.', supersedes: target.id },
        ctx,
      );

      expect(res.status).toBe('pending');
      expect(res.id).toMatch(/^prop_/);
      expect((await getProposal(res.id)).autoHoldReasons).toEqual(['not_computed']);
      const mem = (await getMemory(target.id))!;
      expect(mem.version).toBe(0);
      expect(mem.body).toBe('Treść celu D1.');
      const embAfter = await db.select().from(embeddings).where(eq(embeddings.memoryId, target.id));
      expect(embAfter.map((e) => e.id).sort()).toEqual(embBefore.map((e) => e.id).sort());
    });

    it('(b) supersedes na cel source=human → pending, id prop_, human_target', async () => {
      const { ctx, model, memoryService } = await freshCase();
      const human = await seedApproved({ projectId: ctx.projectId, header: 'Ludzki', body: 'Napisał człowiek.', vector: vec(0, 1), model });

      const res = await memoryService.save(
        { header: 'Ludzki', body: 'Agent poprawia człowieka.', supersedes: human.id },
        ctx,
      );

      expect(res.status).toBe('pending');
      expect(res.id).toMatch(/^prop_/);
      expect((await getProposal(res.id)).autoHoldReasons).toEqual(['human_target']);
      expect((await getMemory(human.id))!.version).toBe(0);
    });

    it('(b′) cel source=agent po edycji człowieka (human_edit) → human_target; edycja zdejmuje znacznik auto', async () => {
      const { ctx, memoryService, memoryAdmin } = await freshCase();
      const target = await memoryService.save({ header: 'Agentowy', body: 'Napisał agent.' }, ctx);
      expect(target.status).toBe('approved');
      expect((await getMemory(target.id))!.autoApprovedAt).not.toBeNull();

      await memoryAdmin.editMemory(target.id, { body: 'Poprawił człowiek.' });
      expect((await getMemory(target.id))!.autoApprovedAt).toBeNull();

      const res = await memoryService.save(
        { header: 'Agentowy', body: 'Agent znów poprawia.', supersedes: target.id },
        ctx,
      );
      expect(res.status).toBe('pending');
      expect((await getProposal(res.id)).autoHoldReasons).toEqual(['human_target']);
    });

    it('(c) limit 2: trzeci zapis → daily_limit; zapisy sprzed >24 h nie liczą się; drugi projekt ma własny licznik', async () => {
      const { ctx, memoryService } = await freshCase({ limit: 2 });
      expect((await memoryService.save({ header: 'L1', body: 'Pierwszy.' }, ctx)).status).toBe('approved');
      expect((await memoryService.save({ header: 'L2', body: 'Drugi.' }, ctx)).status).toBe('approved');
      const third = await memoryService.save({ header: 'L3', body: 'Trzeci.' }, ctx);
      expect(third.status).toBe('pending');
      expect((await proposalForMemory(third.id)).autoHoldReasons).toEqual(['daily_limit']);

      // Inny projekt z tym samym limitem — osobny licznik.
      const other = await freshCase({ limit: 2 });
      expect((await other.memoryService.save({ header: 'O1', body: 'Inny projekt.' }, other.ctx)).status).toBe('approved');

      // Auto-akceptacje sprzed 25 h wypadają z okna.
      await db.execute(
        sql`UPDATE proposals SET auto_approved_at = now() - interval '25 hours' WHERE project_id = ${ctx.projectId} AND auto_approved_at IS NOT NULL`,
      );
      const fourth = await memoryService.save({ header: 'L4', body: 'Czwarty.' }, ctx);
      expect(fourth.status).toBe('approved');
    });

    it('(c) wyścig: limit 1, pięć równoległych zapisów → dokładnie jeden approved, reszta daily_limit', async () => {
      const { ctx, memoryService } = await freshCase({ limit: 1 });
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((i) => memoryService.save({ header: `Wyścig ${i}`, body: `Treść wyścigu ${i}.` }, ctx)),
      );
      expect(results.filter((r) => r.status === 'approved')).toHaveLength(1);
      const pending = results.filter((r) => r.status === 'pending');
      expect(pending).toHaveLength(4);
      for (const r of pending) {
        expect((await proposalForMemory(r.id)).autoHoldReasons).toEqual(['daily_limit']);
      }
      const approvedCount = await db
        .select()
        .from(proposals)
        .where(and(eq(proposals.projectId, ctx.projectId), eq(proposals.status, 'approved')));
      expect(approvedCount).toHaveLength(1);
    });

    it('kilka powodów naraz: near_duplicate + daily_limit', async () => {
      const { ctx, provider, model, memoryService } = await freshCase({ limit: 1 });
      expect((await memoryService.save({ header: 'Zużyj limit', body: 'Jedyna auto-akceptacja.' }, ctx)).status).toBe('approved');
      await seedApproved({ projectId: ctx.projectId, header: 'Bliski', body: 'Bliska treść.', vector: vec(0, 1), model });
      register(provider, { kind: 'fact', header: 'Bliski prim', body: 'Bliska treść prim.' }, [
        vec(0, 1, angleFor(0.02)),
      ]);

      const res = await memoryService.save({ header: 'Bliski prim', body: 'Bliska treść prim.' }, ctx);
      expect(res.status).toBe('pending');
      expect((await proposalForMemory(res.id)).autoHoldReasons).toEqual(['near_duplicate', 'daily_limit']);
    });
  });

  describe('fail-safe', () => {
    it('wyjątek w approve → pending, proposal pending, auto_failed, bez proposal_approved i bez rzucenia', async () => {
      const { ctx, memoryService, proposalsService } = await freshCase();
      vi.spyOn(proposalsService, 'approve').mockRejectedValueOnce(new Error('boom'));

      const res = await memoryService.save({ header: 'Wybuch', body: 'Approve rzuca.' }, ctx);

      expect(res.status).toBe('pending');
      const prop = await proposalForMemory(res.id);
      expect(prop.status).toBe('pending');
      expect(prop.autoHoldReasons).toEqual(['auto_failed']);
      expect(prop.autoApprovedAt).toBeNull();
      expect(await auditEntries('proposal_approved', res.id)).toHaveLength(0);
      expect(await getMemory(res.id)).toBeUndefined();
    });

    it('auto mode wyłączony w międzyczasie (kontekst nieaktualny) → pending, bez powodów', async () => {
      const { ctx, memoryService } = await freshCase();
      await db.update(projectsTable).set({ autoMode: false }).where(eq(projectsTable.id, ctx.projectId));

      const res = await memoryService.save({ header: 'Flip', body: 'Wyłączone po zbudowaniu ctx.' }, ctx);

      expect(res.status).toBe('pending');
      const prop = await proposalForMemory(res.id);
      expect(prop.autoHoldReasons).toBeNull();
      expect(prop.status).toBe('pending');
    });

    it('approve({auto}) bez stagingu wektora → AutoApprovalRefusedError(no_vector), propozycja zostaje pending', async () => {
      const { ctx, provider, memoryService, proposalsService } = await freshCase({ autoMode: false });
      provider.throwOnEmbed = true;
      const res = await memoryService.save({ header: 'Bez stagingu', body: 'Brak wektora.' }, ctx);
      const prop = await proposalForMemory(res.id);
      await db.update(projectsTable).set({ autoMode: true }).where(eq(projectsTable.id, ctx.projectId));

      const err = await proposalsService
        .approve(prop.id, { actor: autoModeActor(ctx.projectId), auto: true, recomputeEmbedding: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AutoApprovalRefusedError);
      expect((err as AutoApprovalRefusedError).reason).toBe('no_vector');
      expect((await getProposal(prop.id)).status).toBe('pending');
    });

    it('approve({auto}) przy wyłączonym auto mode → AutoApprovalRefusedError(disabled)', async () => {
      const { ctx, memoryService, proposalsService } = await freshCase({ autoMode: false });
      const res = await memoryService.save({ header: 'Wyłączony', body: 'Bez auto.' }, ctx);
      const prop = await proposalForMemory(res.id);
      const err = await proposalsService
        .approve(prop.id, { actor: autoModeActor(ctx.projectId), auto: true, recomputeEmbedding: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AutoApprovalRefusedError);
      expect((err as AutoApprovalRefusedError).reason).toBe('disabled');
    });
  });

  describe('G6 — decyzja człowieka zdejmuje znacznik auto', () => {
    it('zatwierdzenie z kolejki korekty (update) przez człowieka → auto_approved_at NULL', async () => {
      const { ctx, memoryService, proposalsService } = await freshCase();
      const target = await memoryService.save({ header: 'G6 cel', body: 'Auto treść.' }, ctx);
      expect((await getMemory(target.id))!.autoApprovedAt).not.toBeNull();

      // Korekta bez auto mode (ctx bez flagi) → pending update w kolejce.
      const correction = await memoryService.save(
        { header: 'G6 cel', body: 'Korekta do akceptacji człowieka.', supersedes: target.id },
        { projectId: ctx.projectId, projectName: ctx.projectName },
      );
      expect(correction.status).toBe('pending');

      await proposalsService.approve(correction.id, { actor: 'human-dashboard' });
      const mem = (await getMemory(target.id))!;
      expect(mem.body).toBe('Korekta do akceptacji człowieka.');
      expect(mem.version).toBe(1);
      expect(mem.autoApprovedAt).toBeNull();
    });

    it('listPendingPage / getProposal niosą autoHoldReasons dla zawróconej, null dla zwykłej', async () => {
      const held = await freshCase();
      held.provider.throwOnEmbed = true;
      const heldRes = await held.memoryService.save({ header: 'Zawrócona', body: 'Bez wektora.' }, held.ctx);
      const heldProp = await proposalForMemory(heldRes.id);

      const plain = await freshCase({ autoMode: false });
      const plainRes = await plain.memoryService.save({ header: 'Zwykła', body: 'Bez auto.' }, plain.ctx);
      const plainProp = await proposalForMemory(plainRes.id);

      const pageHeld = await held.proposalsService.listPendingPage({ projectId: held.ctx.projectId });
      expect(pageHeld.items.find((i) => i.id === heldProp.id)?.autoHoldReasons).toEqual(['not_computed']);
      expect((await held.proposalsService.getProposal(heldProp.id)).autoHoldReasons).toEqual(['not_computed']);
      expect((await held.proposalsService.getProposal(heldProp.id)).autoApprovedAt).toBeNull();

      const pagePlain = await plain.proposalsService.listPendingPage({ projectId: plain.ctx.projectId });
      expect(pagePlain.items.find((i) => i.id === plainProp.id)?.autoHoldReasons).toBeNull();
      expect((await plain.proposalsService.getProposal(plainProp.id)).autoHoldReasons).toBeNull();
    });
  });
});
