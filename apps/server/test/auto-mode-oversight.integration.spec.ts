import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, arrayOverlaps, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { generateId, ID_PREFIX } from '../src/common/ids';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import { DASHBOARD_ACTOR } from '../src/dashboard/dashboard.constants';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import {
  auditLog,
  embeddings,
  memories,
  memoryRelations,
  proposals,
  revisions,
  type MemoryRow,
  type ProposalRow,
} from '../src/db/schema';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { AutoModeUndoService } from '../src/memory/auto-mode-undo.service';
import { MemoryAdminService } from '../src/memory/memory-admin.service';
import { MemoryService } from '../src/memory/memory.service';
import type { ProjectContext, ProjectsService } from '../src/projects/projects.service';
import { AUTO_MODE_UNDO_VIA } from '../src/proposals/auto-mode';
import { ProposalsService } from '../src/proposals/proposals.service';
import { buildAutoModeFateQuery, UsageService } from '../src/usage/usage.service';
import { StubEmbeddingProvider } from './helpers/fakes';
import { buildProjectsService } from './helpers/services';

/**
 * Stub providera (`StubEmbeddingProvider` z `helpers/fakes.ts`): KAŻDY nowy tekst dostaje świeżą, parami
 * ortogonalną oś jednostkową od `FIRST_FREE_AXIS` (dystans 1 do wszystkiego), więc zapisy o różnej treści nigdy nie
 * są względem siebie prawie-duplikatami (bezpiecznik (a) auto mode).
 */
const FIRST_FREE_AXIS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Nadzór po fakcie auto mode — cofanie (A3) i pomiary (A4) (integration, testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let audit: AuditService;
  let usage: UsageService;
  let counter = 0;

  /** Świeży projekt z auto mode, dwoma tokenami (A1, A2) i kompletem serwisów. */
  async function scenario() {
    counter += 1;
    const created = await projects.createProject(`oversight-${counter}`, { label: 'a1' });
    const a1 = created.tokenRow;
    const a2 = (await projects.createToken(created.project.id, 'a2')).tokenRow;
    await projects.updateProject(created.project.id, { autoMode: true, autoModeDailyLimit: 500 });
    const base = { projectId: created.project.id, projectName: created.project.name, autoModeDailyLimit: 500 };
    const ctxA1: ProjectContext = { ...base, autoMode: true, tokenId: a1.id, tokenLabel: a1.label };
    const ctxA2: ProjectContext = { ...base, autoMode: true, tokenId: a2.id, tokenLabel: a2.label };
    /** Ten sam token, ale kontekst bez auto mode → zapis czeka w kolejce (do ręcznej akceptacji w teście). */
    const manualA1: ProjectContext = { ...ctxA1, autoMode: false };

    const config = new AppConfigService(
      envSchema.parse({ DATABASE_URL: 'postgres://unused', NEAR_DUPLICATE_DISTANCE: 0.1, EMBEDDING_SAVE_TIMEOUT_MS: 10_000 }),
    );
    const provider = new StubEmbeddingProvider(`oversight-model-${counter}`, { freshAxisFrom: FIRST_FREE_AXIS });
    const embeddingService = new EmbeddingService(provider, config);
    const proposalsService = new ProposalsService(db, config, audit, embeddingService);
    const memoryService = new MemoryService(db, config, audit, embeddingService, usage, proposalsService);
    const memoryAdmin = new MemoryAdminService(db, config, audit, embeddingService);
    const undo = new AutoModeUndoService(db, audit);
    return {
      projectId: created.project.id,
      a1,
      a2,
      ctxA1,
      ctxA2,
      manualA1,
      memoryService,
      proposalsService,
      memoryAdmin,
      undo,
    };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  async function getMemory(id: string): Promise<MemoryRow> {
    const [row] = await db.select().from(memories).where(eq(memories.id, id)).limit(1);
    return row;
  }

  async function proposalForMemory(memoryId: string, type?: 'create' | 'update'): Promise<ProposalRow> {
    const rows = await db.select().from(proposals);
    const match = rows.find(
      (r) => (r.payload as { memoryId?: string }).memoryId === memoryId && (type === undefined || r.type === type),
    );
    if (!match) throw new Error(`Brak proposala dla memoryId=${memoryId}`);
    return match;
  }

  /** Zapis agenta w trybie auto → pamięć `approved` (assert), zwraca id. */
  async function autoSave(
    s: Scenario,
    ctx: ProjectContext,
    header: string,
    extra: { supersedes?: string; relations?: Array<{ type: 'context_for'; targetId: string }> } = {},
  ): Promise<string> {
    const res = await s.memoryService.save({ header, body: `Treść: ${header}.`, ...extra }, ctx);
    expect(res.status).toBe('approved');
    return res.id;
  }

  /** Zapis w kolejce zatwierdzony przez człowieka (actor `human-dashboard`), z opcjonalnym `supersedes` celu. */
  async function humanApprovedSave(s: Scenario, header: string, supersedes?: string): Promise<string> {
    const res = await s.memoryService.save({ header, body: `Treść: ${header}.`, supersedes }, s.manualA1);
    expect(res.status).toBe('pending');
    const prop = await db.select().from(proposals).where(eq(proposals.id, res.id)).limit(1);
    // `save` zwraca id proposala (update/pending) albo id pamięci (create/pending) — znajdź propozycję.
    const proposalId = prop[0]?.id ?? (await proposalForMemory(res.id)).id;
    await s.proposalsService.approve(proposalId, { actor: DASHBOARD_ACTOR });
    return supersedes ?? res.id;
  }

  async function auditFor(memoryId: string, eventType: 'archive' | 'relation_removed') {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.eventType, eventType), arrayOverlaps(auditLog.affectedIds, [memoryId])));
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    projects = buildProjectsService(db, new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' })));
    audit = new AuditService(db);
    usage = new UsageService(db);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('nośnik tokena i niezmiennik znaczników czasu', () => {
    it('save (create i supersede) zapisuje ctx.tokenId w proposals.token_id; bez tokena w ctx → NULL', async () => {
      const s = await scenario();
      const created = await s.memoryService.save({ header: 'Token create', body: 'Treść.' }, s.manualA1);
      const createProp = await proposalForMemory(created.id, 'create');
      expect(createProp.tokenId).toBe(s.a1.id);

      const target = await humanApprovedSave(s, 'Cel dla supersede');
      const sup = await s.memoryService.save(
        { header: 'Cel dla supersede', body: 'Poprawiona.', supersedes: target },
        { ...s.manualA1, tokenId: s.a2.id, tokenLabel: 'a2' },
      );
      const [updateProp] = await db.select().from(proposals).where(eq(proposals.id, sup.id));
      expect(updateProp.type).toBe('update');
      expect(updateProp.tokenId).toBe(s.a2.id);

      const noToken = await s.memoryService.save(
        { header: 'Bez tokena', body: 'Treść.' },
        { projectId: s.projectId, projectName: 'x' },
      );
      expect((await proposalForMemory(noToken.id)).tokenId).toBeNull();
    });

    it('auto-akceptacja: memories.auto_approved_at === proposals.auto_approved_at (create i update)', async () => {
      const s = await scenario();
      const id = await autoSave(s, s.ctxA1, 'Niezmiennik czasu');
      const createProp = await proposalForMemory(id, 'create');
      expect((await getMemory(id)).autoApprovedAt?.getTime()).toBe(createProp.autoApprovedAt?.getTime());
      expect(createProp.autoApprovedAt).not.toBeNull();

      await autoSave(s, s.ctxA1, 'Niezmiennik czasu', { supersedes: id });
      const [corrected, ...rest] = (await db.select().from(proposals).where(eq(proposals.type, 'update'))).filter(
        (p) => (p.payload as { memoryId?: string }).memoryId === id,
      );
      expect(rest).toHaveLength(0);
      expect((await getMemory(id)).autoApprovedAt?.getTime()).toBe(corrected.autoApprovedAt?.getTime());
      expect(corrected.autoApprovedAt?.getTime()).toBeGreaterThan(createProp.autoApprovedAt!.getTime());
    });
  });

  describe('lista przeglądarki: przedział, token, autoCorrection', () => {
    it('autoTokenId zwraca tylko wpisy, których bieżąca treść przyszła z tego tokena; autoCorrection tylko dla korekt', async () => {
      const s = await scenario();
      const x1 = await autoSave(s, s.ctxA1, 'Lista A1 jeden');
      const x2 = await autoSave(s, s.ctxA2, 'Lista A2 jeden');
      // utworzone przez A1, ale bieżąca treść z korekty A2
      const x3 = await autoSave(s, s.ctxA1, 'Lista A1 do korekty');
      await autoSave(s, s.ctxA2, 'Lista A1 do korekty', { supersedes: x3 });
      // auto-utworzone, potem edytowane przez człowieka → znika z filtra auto
      const edited = await autoSave(s, s.ctxA1, 'Lista edytowane');
      await s.memoryAdmin.editMemory(edited, { body: 'Człowiek poprawił.' });
      // zatwierdzone przez człowieka → auto-korekta
      const corr = await humanApprovedSave(s, 'Lista korekta człowieka');
      await autoSave(s, s.ctxA2, 'Lista korekta człowieka', { supersedes: corr });

      const filter = { scope: 'project', projectId: s.projectId, autoApproved: true } as const;
      const all = await s.memoryAdmin.listMemories(filter);
      expect(all.map((m) => m.id).sort()).toEqual([x1, x2, x3, corr].sort());
      expect(Object.fromEntries(all.map((m) => [m.id, m.autoCorrection]))).toEqual({
        [x1]: false,
        [x2]: false,
        [x3]: false,
        [corr]: true,
      });

      const byA1 = await s.memoryAdmin.listMemories({ ...filter, autoTokenId: s.a1.id });
      expect(byA1.map((m) => m.id)).toEqual([x1]);
      const byA2 = await s.memoryAdmin.listMemories({ ...filter, autoTokenId: s.a2.id });
      expect(byA2.map((m) => m.id).sort()).toEqual([x2, x3, corr].sort());

      const detail = await s.memoryAdmin.getMemoryDetail(corr);
      expect(detail.autoCorrection).toBe(true);
      expect((await s.memoryAdmin.getMemoryDetail(x1)).autoCorrection).toBe(false);
      expect((await s.memoryAdmin.getMemoryDetail(edited)).autoCorrection).toBe(false);
    });

    it('przedział po auto_approved_at: from/to zawężają listę', async () => {
      const s = await scenario();
      const early = await autoSave(s, s.ctxA1, 'Przedział wczesny');
      await sleep(30);
      const mid = new Date();
      await sleep(30);
      const late = await autoSave(s, s.ctxA1, 'Przedział późny');

      const filter = { scope: 'project', projectId: s.projectId, autoApproved: true } as const;
      expect((await s.memoryAdmin.listMemories({ ...filter, autoFrom: mid })).map((m) => m.id)).toEqual([late]);
      expect((await s.memoryAdmin.listMemories({ ...filter, autoTo: mid })).map((m) => m.id)).toEqual([early]);
      expect(await s.memoryAdmin.listMemories({ ...filter, autoFrom: new Date(Date.now() + 60_000) })).toHaveLength(0);
    });
  });

  describe('AutoModeUndoService.preview', () => {
    /** 2× A1 create, 1× A2 create, 1 edytowana przez człowieka, 1 zatwierdzona przez człowieka + auto-korekta (M),
     * 1 auto-create + auto-korekta tokenem A2 (kandydat), 1 auto-create + korekta człowieka + auto-korekta (M). */
    async function populate(s: Scenario) {
      const a1one = await autoSave(s, s.ctxA1, 'Podgląd A1 jeden');
      const a1two = await autoSave(s, s.ctxA1, 'Podgląd A1 dwa');
      const a2one = await autoSave(s, s.ctxA2, 'Podgląd A2 jeden');
      const edited = await autoSave(s, s.ctxA1, 'Podgląd edytowane');
      await s.memoryAdmin.editMemory(edited, { body: 'Człowiek.' });
      const humanThenAuto = await humanApprovedSave(s, 'Podgląd człowiek potem auto');
      await autoSave(s, s.ctxA2, 'Podgląd człowiek potem auto', { supersedes: humanThenAuto });
      const autoThenAuto = await autoSave(s, s.ctxA1, 'Podgląd auto potem auto');
      await autoSave(s, s.ctxA2, 'Podgląd auto potem auto', { supersedes: autoThenAuto });
      const autoHumanAuto = await autoSave(s, s.ctxA1, 'Podgląd auto człowiek auto');
      await humanApprovedSave(s, 'Podgląd auto człowiek auto', autoHumanAuto);
      await autoSave(s, s.ctxA2, 'Podgląd auto człowiek auto', { supersedes: autoHumanAuto });
      return { a1one, a1two, a2one, edited, humanThenAuto, autoThenAuto, autoHumanAuto };
    }

    it('N i M: kandydaci = utworzone przez auto i nietknięte przez człowieka; reszta to pominięte auto-korekty', async () => {
      const s = await scenario();
      const m = await populate(s);

      const preview = await s.undo.preview({ projectId: s.projectId });
      expect(preview.ids.slice().sort()).toEqual([m.a1one, m.a1two, m.a2one, m.autoThenAuto].sort());
      expect(preview.archivable).toBe(4);
      expect(preview.skippedCorrections).toBe(2); // humanThenAuto + autoHumanAuto
      expect(preview.capped).toBe(false);
      expect(new Date(preview.asOf).getTime()).toBeLessThanOrEqual(Date.now());
      // kolejność: najstarsze auto_approved_at pierwsze
      const times = await Promise.all(preview.ids.map(async (id) => (await getMemory(id)).autoApprovedAt!.getTime()));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('token zawęża do wpisów, których bieżąca treść przyszła z tego tokena; zakres czasu też', async () => {
      const s = await scenario();
      const m = await populate(s);

      const a1 = await s.undo.preview({ projectId: s.projectId, tokenId: s.a1.id });
      expect(a1.ids.slice().sort()).toEqual([m.a1one, m.a1two].sort());
      expect(a1.skippedCorrections).toBe(0);

      const a2 = await s.undo.preview({ projectId: s.projectId, tokenId: s.a2.id });
      expect(a2.ids.slice().sort()).toEqual([m.a2one, m.autoThenAuto].sort());
      expect(a2.archivable).toBe(2);
      expect(a2.skippedCorrections).toBe(2);

      const future = await s.undo.preview({ projectId: s.projectId, from: new Date(Date.now() + 60_000) });
      expect(future.archivable).toBe(0);
      expect(future.skippedCorrections).toBe(0);
      // `to` w przeszłości zamraża asOf na tej granicy
      const past = new Date(Date.now() - 3_600_000);
      const none = await s.undo.preview({ projectId: s.projectId, to: past });
      expect(none.asOf).toBe(past.toISOString());
      expect(none.archivable).toBe(0);
    });

    it('cap: ids ≤ maxIds (najstarsze), archivable zostaje prawdziwą liczbą, capped=true', async () => {
      const s = await scenario();
      const ids: string[] = [];
      for (const n of [1, 2, 3, 4]) ids.push(await autoSave(s, s.ctxA1, `Cap ${n}`));

      const preview = await s.undo.preview({ projectId: s.projectId }, { maxIds: 2 });
      expect(preview.archivable).toBe(4);
      expect(preview.ids).toEqual(ids.slice(0, 2));
      expect(preview.capped).toBe(true);
    });

    it('nieznany projekt → not_found; projekt bez auto-wpisów → zera', async () => {
      const s = await scenario();
      await expect(s.undo.preview({ projectId: 'proj_nieistnieje' })).rejects.toMatchObject({ code: 'not_found' });
      expect(await s.undo.preview({ projectId: s.projectId })).toMatchObject({
        archivable: 0,
        skippedCorrections: 0,
        ids: [],
        capped: false,
      });
    });

    it('lista przeglądarki i podgląd zgadzają się: lista(autoApproved) = N + M', async () => {
      const s = await scenario();
      await populate(s);
      const list = await s.memoryAdmin.listMemories({ scope: 'project', projectId: s.projectId, autoApproved: true });
      const preview = await s.undo.preview({ projectId: s.projectId });
      expect(list).toHaveLength(preview.archivable + preview.skippedCorrections);
      expect(list.filter((m) => m.autoCorrection)).toHaveLength(preview.skippedCorrections);
    });
  });

  describe('AutoModeUndoService.execute', () => {
    it('archiwizuje dokładnie ids z podglądu jak ręczna archiwizacja, ze znacznikiem źródła; późniejszy auto-zapis zostaje approved', async () => {
      const s = await scenario();
      const a = await autoSave(s, s.ctxA1, 'Cofanie A');
      const b = await autoSave(s, s.ctxA1, 'Cofanie B', { relations: [{ type: 'context_for', targetId: a }] });
      const c = await autoSave(s, s.ctxA2, 'Cofanie C');
      const human = await autoSave(s, s.ctxA1, 'Cofanie człowiek');
      await s.memoryAdmin.editMemory(human, { body: 'Człowiek.' });
      // relacja z pamięcią spoza cofania — też ma zniknąć razem z archiwizowaną pamięcią
      const outside = await autoSave(s, s.ctxA1, 'Cofanie spoza', { relations: [{ type: 'context_for', targetId: c }] });
      await s.memoryAdmin.editMemory(outside, { body: 'Człowiek edytuje.' });

      const preview = await s.undo.preview({ projectId: s.projectId });
      expect(preview.ids.slice().sort()).toEqual([a, b, c].sort());
      const before = new Map(await Promise.all(preview.ids.map(async (id) => [id, await getMemory(id)] as const)));

      const afterPreview = await autoSave(s, s.ctxA1, 'Cofanie po podglądzie');

      const result = await s.undo.execute({ projectId: s.projectId, ids: preview.ids });
      expect(result).toMatchObject({ archived: 3, skipped: 0 });
      expect(result.undoId).toMatch(/^undo_[0-9a-z]{12}$/);

      for (const id of preview.ids) {
        const row = await getMemory(id);
        expect(row.status).toBe('archived');
        expect(row.version).toBe(before.get(id)!.version + 1);
        expect(row.autoApprovedAt).toBeNull();
        expect(await db.select().from(embeddings).where(eq(embeddings.memoryId, id))).toHaveLength(0);

        const revs = await db.select().from(revisions).where(and(eq(revisions.memoryId, id), eq(revisions.action, 'archive')));
        expect(revs).toHaveLength(1);
        expect(revs[0].actor).toBe(DASHBOARD_ACTOR);
        expect(revs[0].snapshot).toMatchObject({ header: before.get(id)!.header, version: before.get(id)!.version });

        const archiveEvents = await auditFor(id, 'archive');
        expect(archiveEvents).toHaveLength(1);
        expect(archiveEvents[0].actor).toBe(DASHBOARD_ACTOR);
        expect(archiveEvents[0].metadata).toEqual({ via: AUTO_MODE_UNDO_VIA, undoId: result.undoId });
      }

      // wszystkie krawędzie dotykające archiwizowanych zniknęły, każda z audytem relation_removed via 'archive'
      const remaining = await db
        .select()
        .from(memoryRelations)
        .where(inArray(memoryRelations.fromMemoryId, [a, b, c, outside]));
      expect(remaining).toHaveLength(0);
      const removed = await auditFor(a, 'relation_removed');
      expect(removed).toHaveLength(1); // b→a
      expect(removed[0].metadata).toMatchObject({ via: 'archive', fromMemoryId: b, toMemoryId: a });
      expect(await auditFor(c, 'relation_removed')).toHaveLength(1); // outside→c

      // nietknięte: edytowana przez człowieka i zapisana po podglądzie
      expect((await getMemory(human)).status).toBe('approved');
      expect((await getMemory(afterPreview)).status).toBe('approved');
      expect((await getMemory(afterPreview)).autoApprovedAt).not.toBeNull();
    });

    it('człowiek ruszył wpis między podglądem a wykonaniem → skipped, wpis zostaje approved', async () => {
      const s = await scenario();
      const a = await autoSave(s, s.ctxA1, 'Wyścig A');
      const b = await autoSave(s, s.ctxA1, 'Wyścig B');
      const c = await autoSave(s, s.ctxA1, 'Wyścig C');
      const preview = await s.undo.preview({ projectId: s.projectId });
      expect(preview.archivable).toBe(3);

      await s.memoryAdmin.editMemory(a, { body: 'Człowiek edytuje po podglądzie.' });
      await s.memoryAdmin.archiveMemory(c); // ręcznie zarchiwizowany w międzyczasie

      const result = await s.undo.execute({ projectId: s.projectId, ids: preview.ids });
      expect(result).toMatchObject({ archived: 1, skipped: 2 });
      expect((await getMemory(a)).status).toBe('approved');
      expect((await getMemory(a)).version).toBe(1);
      expect((await getMemory(b)).status).toBe('archived');
      expect(await auditFor(a, 'archive')).toHaveLength(0);
      // c: tylko JEDEN archive (ręczny, bez metadata) — cofanie go nie powtórzyło
      const cEvents = await auditFor(c, 'archive');
      expect(cEvents).toHaveLength(1);
      expect(cEvents[0].metadata).toBeNull();
    });

    it('auto-korekta kandydata PO podglądzie nie wyklucza go (dotknął ją tylko agent)', async () => {
      const s = await scenario();
      const a = await autoSave(s, s.ctxA1, 'Korekta po podglądzie');
      const preview = await s.undo.preview({ projectId: s.projectId });
      await autoSave(s, s.ctxA2, 'Korekta po podglądzie', { supersedes: a });
      const result = await s.undo.execute({ projectId: s.projectId, ids: preview.ids });
      expect(result).toMatchObject({ archived: 1, skipped: 0 });
      expect((await getMemory(a)).status).toBe('archived');
    });

    it('id z innego projektu / duplikaty / nieistniejące → skipped, nic nie zmienione', async () => {
      const s = await scenario();
      const other = await scenario();
      const mine = await autoSave(s, s.ctxA1, 'Mój wpis');
      const theirs = await autoSave(other, other.ctxA1, 'Cudzy wpis');

      const result = await s.undo.execute({ projectId: s.projectId, ids: [theirs, theirs, 'mem_nieistnieje', mine] });
      expect(result).toMatchObject({ archived: 1, skipped: 2 });
      expect((await getMemory(theirs)).status).toBe('approved');
      expect((await getMemory(theirs)).autoApprovedAt).not.toBeNull();
      expect((await getMemory(mine)).status).toBe('archived');
    });
  });

  describe('UsageService.autoModeFates — los auto-akceptacji (A4)', () => {
    const range = () => ({ from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) });

    it('pierwsze zdarzenie spoza auto mode wyznacza kubełek; późniejsza auto-korekta go nie zmienia', async () => {
      const s = await scenario();
      // c1: edycja człowieka → nadpisane
      const c1 = await autoSave(s, s.ctxA1, 'Los edycja');
      await s.memoryAdmin.editMemory(c1, { body: 'Człowiek.' });
      // c2: ręczna archiwizacja → zarchiwizowane
      const c2 = await autoSave(s, s.ctxA1, 'Los archiwizacja');
      await s.memoryAdmin.archiveMemory(c2);
      // c3: cofanie → cofnięte
      const c3 = await autoSave(s, s.ctxA1, 'Los cofanie');
      await s.undo.execute({ projectId: s.projectId, ids: [c3] });
      // c4: nocny delete zatwierdzony przez człowieka → przycięte
      const c4 = await autoSave(s, s.ctxA1, 'Los nocny delete');
      const nightlyId = generateId(ID_PREFIX.proposal);
      await db.insert(proposals).values({
        id: nightlyId,
        type: 'delete',
        origin: 'nightly',
        status: 'pending',
        payload: { memoryId: c4 },
        affectedIds: [c4],
        baseVersions: { [c4]: (await getMemory(c4)).version },
        scope: 'project',
        projectId: s.projectId,
      });
      await s.proposalsService.approve(nightlyId, { actor: DASHBOARD_ACTOR });
      // c5: korekta agenta zatwierdzona przez człowieka → nadpisane
      const c5 = await autoSave(s, s.ctxA1, 'Los korekta człowieka');
      await humanApprovedSave(s, 'Los korekta człowieka', c5);
      // c6: create z supersedes zatwierdzony przez człowieka → zarchiwizowane
      const c6 = await autoSave(s, s.ctxA1, 'Los supersede');
      const replacement = await s.memoryService.save({ header: 'Los zastępca', body: 'Zastępuje c6.' }, s.manualA1);
      const replacementProposal = await proposalForMemory(replacement.id, 'create');
      await s.proposalsService.approve(replacementProposal.id, { actor: DASHBOARD_ACTOR, supersedes: c6 });
      // c7: auto-create → auto-korekta → edycja człowieka: create ORAZ update nadpisane
      const c7 = await autoSave(s, s.ctxA1, 'Los auto auto człowiek');
      await autoSave(s, s.ctxA2, 'Los auto auto człowiek', { supersedes: c7 });
      await s.memoryAdmin.editMemory(c7, { body: 'Człowiek na końcu.' });
      // c8: nietknięte; c9: nietknięte, ale auto-korekta (osobny wiersz update, też nietknięty)
      await autoSave(s, s.ctxA1, 'Los nietknięty');
      const c9 = await autoSave(s, s.ctxA1, 'Los z korektą');
      await autoSave(s, s.ctxA2, 'Los z korektą', { supersedes: c9 });
      // c10: poza zakresem (auto-akceptacja sprzed 10 dni)
      const c10 = await autoSave(s, s.ctxA1, 'Los poza zakresem');
      await db
        .update(proposals)
        .set({ autoApprovedAt: new Date(Date.now() - 10 * 86_400_000) })
        .where(eq(proposals.id, (await proposalForMemory(c10, 'create')).id));

      const rows = await usage.autoModeFates({ ...range(), projectId: s.projectId });
      const create = rows.find((r) => r.type === 'create')!;
      const update = rows.find((r) => r.type === 'update')!;
      expect(rows).toHaveLength(2);
      expect(create).toMatchObject({
        projectId: s.projectId,
        autoMode: true,
        total: 9, // c1..c9 (c10 poza zakresem)
        overwritten: 3, // c1, c5, c7
        archived: 2, // c2, c6
        undone: 1, // c3
        pruned: 1, // c4
      });
      // c8 + c9 zostają nietknięte (total − Σ kubełków)
      expect(create.total - create.overwritten - create.archived - create.undone - create.pruned).toBe(2);
      expect(update).toMatchObject({ total: 2, overwritten: 1, archived: 0, undone: 0, pruned: 0 }); // c7 → człowiek; c9 → nietknięte
    });

    it('nocny update (LLM) zatwierdzony przez człowieka → przycięte; projekt z auto mode wyłączonym dziś dalej ma wiersz', async () => {
      const s = await scenario();
      const id = await autoSave(s, s.ctxA1, 'Los nocny update');
      const nightlyId = generateId(ID_PREFIX.proposal);
      await db.insert(proposals).values({
        id: nightlyId,
        type: 'update',
        origin: 'nightly',
        status: 'pending',
        payload: { memoryId: id, body: 'Skrócone.' },
        affectedIds: [id],
        baseVersions: { [id]: (await getMemory(id)).version },
        scope: 'project',
        projectId: s.projectId,
      });
      await s.proposalsService.approve(nightlyId, { actor: DASHBOARD_ACTOR });
      await projects.updateProject(s.projectId, { autoMode: false });

      const rows = await usage.autoModeFates({ ...range(), projectId: s.projectId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'create', autoMode: false, total: 1, pruned: 1 });
    });

    it('bez projectId zwraca wszystkie projekty z kohortą w zakresie; pusty zakres → brak wierszy', async () => {
      const s = await scenario();
      await autoSave(s, s.ctxA1, 'Los globalny');
      const rows = await usage.autoModeFates(range());
      expect(rows.some((r) => r.projectId === s.projectId)).toBe(true);
      const empty = await usage.autoModeFates({ from: new Date(Date.now() + 3_600_000), to: new Date(Date.now() + 7_200_000) });
      expect(empty).toEqual([]);
    });

    it('plan zapytania przy realistycznym audycie szuka losu pamięci przez GIN audit_affected_ids_idx', async () => {
      const s = await scenario();
      await autoSave(s, s.ctxA1, 'Los plan');
      const { sql: text, params } = new PgDialect().sqlToQuery(buildAutoModeFateQuery({ ...range(), projectId: s.projectId }));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Duży audyt (typy werdyktu są popularne, więc indeks po event_type nie jest selektywny) + świeże statystyki;
        // całość cofnięta ROLLBACK-iem, nie zaśmieca bazy pozostałych testów.
        await client.query(`
          INSERT INTO audit_log (id, event_type, actor, affected_ids, created_at)
          SELECT 'evt_plan_' || g, (ARRAY['human_edit','archive','proposal_approved'])[1 + g % 3]::audit_event_type,
                 'human-dashboard', ARRAY['mem_plan_' || g], now() - (g || ' seconds')::interval
          FROM generate_series(1, 30000) g`);
        await client.query('ANALYZE audit_log');
        const plan = await client.query<Record<string, string>>(`EXPLAIN ${text}`, params);
        await client.query('ROLLBACK');
        expect(plan.rows.map((r) => r['QUERY PLAN']).join(' | ')).toContain('audit_affected_ids_idx');
      } finally {
        client.release();
      }
    });
  });

  describe('UsageService.autoHoldStats — powody zawróceń (A4)', () => {
    async function insertHeld(projectId: string, reasons: string[], createdAt = new Date()) {
      await db.insert(proposals).values({
        id: generateId(ID_PREFIX.proposal),
        type: 'create',
        origin: 'agent',
        status: 'pending',
        payload: { memoryId: generateId(ID_PREFIX.memory) },
        affectedIds: [],
        baseVersions: {},
        scope: 'project',
        projectId,
        autoHoldReasons: reasons as never,
        createdAt,
      });
    }

    it('liczy propozycję raz w held i w każdym swoim powodzie; zakres i projectId zawężają', async () => {
      const s = await scenario();
      const other = await scenario();
      await insertHeld(s.projectId, ['near_duplicate', 'daily_limit']);
      await insertHeld(s.projectId, ['auto_failed']);
      await insertHeld(s.projectId, ['near_duplicate'], new Date(Date.now() - 10 * 86_400_000)); // poza zakresem
      await insertHeld(other.projectId, ['human_target']);
      // propozycja bez powodów (zwykła pending) nie wchodzi
      await db.insert(proposals).values({
        id: generateId(ID_PREFIX.proposal),
        type: 'create',
        origin: 'agent',
        status: 'pending',
        payload: { memoryId: generateId(ID_PREFIX.memory) },
        affectedIds: [],
        baseVersions: {},
        scope: 'project',
        projectId: s.projectId,
      });

      const range = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) };
      const rows = await usage.autoHoldStats({ ...range, projectId: s.projectId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        projectId: s.projectId,
        autoMode: true,
        held: 2,
        reasons: { near_duplicate: 1, not_computed: 0, human_target: 0, daily_limit: 1, auto_failed: 1 },
      });

      const both = await usage.autoHoldStats(range);
      const otherRow = both.find((r) => r.projectId === other.projectId)!;
      expect(otherRow).toMatchObject({ held: 1, reasons: { human_target: 1 } });
    });
  });
});
