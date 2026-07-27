import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { generateId, ID_PREFIX } from '../src/common/ids';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import {
  EMBEDDING_DIM,
  embeddings,
  memories,
  proposals,
  type MemoryRow,
  type NewMemoryRow,
  type ProposalRow,
} from '../src/db/schema';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { NIGHTLY_LOCK_KEY, NightlyService } from '../src/nightly/nightly.service';
import { RecencyPruneScorer } from '../src/nightly/prune-scorer';
import type { ProjectContext } from '../src/projects/projects.service';
import { ProjectsService } from '../src/projects/projects.service';
import { ProposalsService } from '../src/proposals/proposals.service';
import { UsageService } from '../src/usage/usage.service';

/** Jak w `proposals.integration.spec.ts` — testcontainers nie odpala prawdziwego sidecara TEI.
 * Nightly nigdy nie woła `embed()` podczas detekcji (czyta wektory z `embeddings` bezpośrednio) —
 * ten stub jest tu wyłącznie dla `ProposalsService.approve()` w scenariuszu 7 (recompute embeddingu
 * scalonej pamięci C). */
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;
  throwOnEmbed = false;
  constructor(public model: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (this.throwOnEmbed) throw new Error('StubEmbeddingProvider: symulowana awaria');
    return texts.map(() => new Array(EMBEDDING_DIM).fill(0.01));
  }

  async health(): Promise<boolean> {
    return !this.throwOnEmbed;
  }
}

/** Jednostkowy wektor z kontrolowanym component0 (jak `topicVector` w `memory.integration.spec.ts`):
 * dwa fakty z TYM SAMYM component0 mają dystans kosinusowy 0 (near-identical, wewnątrz domyślnego
 * progu 0.05); component0=1 vs component0=0 są ortogonalne -> dystans ~1 (poza progiem). */
function unitVector(component0: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = component0;
  v[1] = Math.sqrt(Math.max(0, 1 - component0 * component0));
  return v;
}

const NEAR = unitVector(1); // wspólny wektor dla par "near-identical" (dystans do siebie = 0)
const DISTINCT = unitVector(0); // ortogonalny -> dystans ~1, zdecydowanie poza NIGHTLY_DEDUP_DISTANCE

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

const ACTIVE_MODEL = 'nightly-test-model';

describe('NightlyService (integration, testcontainers) — Faza 6 nocny job', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let audit: AuditService;

  /** Nowa (config, nightly, proposals) trójka do testów, które potrzebują własnego env override
   * (jak `buildServices` w `proposals.integration.spec.ts`). Embedding provider zawsze ten sam stub
   * modelowy — detekcja nightly filtruje po `embedding.model`, więc wektory seedowane w testach
   * muszą nosić DOKŁADNIE `ACTIVE_MODEL`. */
  function buildServices(envOverrides: Record<string, unknown> = {}): {
    config: AppConfigService;
    nightly: NightlyService;
    proposalsService: ProposalsService;
  } {
    const config = new AppConfigService(
      envSchema.parse({ DATABASE_URL: 'postgres://unused', ...envOverrides }),
    );
    const embeddingService = new EmbeddingService(new StubEmbeddingProvider(ACTIVE_MODEL), config);
    const nightly = new NightlyService(
      db,
      pool,
      config,
      audit,
      embeddingService,
      new RecencyPruneScorer(),
      new UsageService(db),
    );
    const proposalsService = new ProposalsService(db, config, audit, embeddingService);
    return { config, nightly, proposalsService };
  }

  async function seedFact(projectId: string, overrides: Partial<NewMemoryRow> = {}): Promise<MemoryRow> {
    const [row] = await db
      .insert(memories)
      .values({
        id: generateId(ID_PREFIX.memory),
        header: 'Seed header',
        body: 'Seed body.',
        kind: 'fact',
        tags: [],
        scope: 'project',
        projectId,
        status: 'approved',
        source: 'human',
        version: 0,
        accessCount: 0,
        approvedAt: new Date(),
        ...overrides,
      })
      .returning();
    return row;
  }

  async function seedVector(memoryId: string, vector: number[]): Promise<void> {
    await db.insert(embeddings).values({
      id: generateId(ID_PREFIX.embedding),
      memoryId,
      chunkIndex: 0,
      chunkText: 'chunk',
      embeddingModel: ACTIVE_MODEL,
      vector,
    });
  }

  async function seedFactWithVector(
    projectId: string,
    overrides: Partial<NewMemoryRow>,
    vector: number[],
  ): Promise<MemoryRow> {
    const row = await seedFact(projectId, overrides);
    await seedVector(row.id, vector);
    return row;
  }

  /** Znajduje pending/withdrawn/etc. nightly proposal po (type, zbiór affectedIds) — dopasowanie
   * nieuporządkowane, bo `conditionKey` sortuje wewnętrznie i tak samo powinien porównywać test. */
  async function findNightlyProposal(
    type: ProposalRow['type'],
    affectedIds: string[],
    status: ProposalRow['status'] = 'pending',
  ): Promise<ProposalRow | undefined> {
    const rows = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.origin, 'nightly'), eq(proposals.type, type), eq(proposals.status, status)));
    const wanted = [...affectedIds].sort();
    return rows.find((r) => {
      const got = [...r.affectedIds].sort();
      return got.length === wanted.length && got.every((id, i) => id === wanted[i]);
    });
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });

    projects = new ProjectsService(db, new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' })));
    audit = new AuditService(db);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // Scenariusze 1, 2, 5 (+ dodatkowy "technical bump" z Ryzyk planu), 3, 4 — muszą iść W TEJ
  // KOLEJNOŚCI na WSPÓLNYM fixture (jeden projekt), żeby liczniki (`counters`) w scenariuszach 1/2
  // były policzalne z pewnością (pierwszy przebieg w całym pliku testowym — baza pusta poza tym
  // fixture). Dalsze describe-bloki (prune/approve/lock/audit) NIE polegają już na globalnych
  // licznikach — sprawdzają konkretne wiersze `proposals`, odporne na fixture innych testów.
  describe('merge lifecycle: detect -> idempotent re-scan -> stale re-derive -> orphan withdraw', () => {
    let projectA: ProjectContext;
    let factA: MemoryRow;
    let factB: MemoryRow;
    let factC: MemoryRow; // wektor ortogonalny — nigdy nie powinien wejść do klastra (scenariusz 5)

    it('scenariusz 1: dwa near-identical facts -> jeden merge proposal, poprawne affectedIds/baseVersions', async () => {
      const created = await projects.createProject('nightly-merge-test');
      projectA = { projectId: created.project.id, projectName: created.project.name };

      factA = await seedFactWithVector(projectA.projectId, { header: 'Fakt A', body: 'Tresc A.' }, NEAR);
      factB = await seedFactWithVector(projectA.projectId, { header: 'Fakt B', body: 'Tresc B duzo dluzsza.' }, NEAR);
      // Fresh (age=0) -> nigdy nie kwalifikuje się do prune; ortogonalny wektor -> nigdy do merge.
      factC = await seedFactWithVector(
        projectA.projectId,
        { header: 'Fakt C (odrebny)', body: 'Tresc C, niepowiazana.' },
        DISTINCT,
      );

      const { nightly } = buildServices();
      const result = await nightly.run({ actor: 'tester' });

      expect(result.status).toBe('success');
      expect(result.counters).toEqual({
        created: 1,
        withdrawn: 0,
        skippedAsDup: 0,
        mergeProposed: 1,
        pruneProposed: 0,
        skippedPoliteness: 0,
        skippedCap: 0,
        searchEventsPruned: 0,
      });

      const proposalRow = await findNightlyProposal('merge', [factA.id, factB.id]);
      expect(proposalRow).toBeDefined();
      expect([...proposalRow!.affectedIds].sort()).toEqual([factA.id, factB.id].sort());
      expect(proposalRow!.baseVersions).toEqual({ [factA.id]: 0, [factB.id]: 0 });
      expect(proposalRow!.contentHash).toBeNull();
      expect(proposalRow!.scope).toBe('project');
      expect(proposalRow!.projectId).toBe(projectA.projectId);
      // Kanoniczny wybór: accessCount remisuje (0=0) -> dłuższy body wygrywa -> Fakt B.
      expect((proposalRow!.payload as { header: string }).header).toBe('Fakt B');

      // Scenariusz 5: fakt o odrębnym wektorze NIE wchodzi do żadnego proposala nightly.
      const untouchedA = await findNightlyProposal('merge', [factA.id, factC.id]);
      const untouchedB = await findNightlyProposal('merge', [factB.id, factC.id]);
      expect(untouchedA).toBeUndefined();
      expect(untouchedB).toBeUndefined();
    });

    it('scenariusz 2: run ponownie -> idempotentne (0 created, 0 withdrawn, 1 skipped)', async () => {
      const { nightly } = buildServices();
      const result = await nightly.run({ actor: 'tester' });

      expect(result.status).toBe('success');
      expect(result.counters).toEqual({
        created: 0,
        withdrawn: 0,
        skippedAsDup: 1,
        mergeProposed: 0,
        pruneProposed: 0,
        skippedPoliteness: 0,
        skippedCap: 0,
        searchEventsPruned: 0,
      });
    });

    it('techniczny bump (accessCount/lastAccessedAt BEZ version, jak MemoryService.get) NIE unieważnia proposala', async () => {
      // `MemoryService.get()` bumpuje access_count/last_accessed_at, ale NIGDY version — replikujemy
      // to bezpośrednio (bez pełnego DI MemoryService) żeby sprawdzić ryzyko z planu §3.
      await db
        .update(memories)
        .set({ accessCount: 5, lastAccessedAt: new Date() })
        .where(eq(memories.id, factA.id));

      const { nightly } = buildServices();
      const result = await nightly.run({ actor: 'tester' });

      expect(result.counters.created).toBe(0);
      expect(result.counters.withdrawn).toBe(0);
      expect(result.counters.skippedAsDup).toBe(1);

      const stillPending = await findNightlyProposal('merge', [factA.id, factB.id], 'pending');
      expect(stillPending).toBeDefined();
    });

    it('scenariusz 3: bump wersji jednego członka poza kolejką -> stary proposal withdrawn, świeży utworzony', async () => {
      const before = await findNightlyProposal('merge', [factA.id, factB.id], 'pending');
      expect(before).toBeDefined();

      await db.update(memories).set({ version: 1 }).where(eq(memories.id, factB.id));

      const { nightly } = buildServices();
      await nightly.run({ actor: 'tester' });

      const [oldAfter] = await db.select().from(proposals).where(eq(proposals.id, before!.id));
      expect(oldAfter.status).toBe('withdrawn');

      const fresh = await findNightlyProposal('merge', [factA.id, factB.id], 'pending');
      expect(fresh).toBeDefined();
      expect(fresh!.id).not.toBe(before!.id);
      expect(fresh!.baseVersions).toEqual({ [factA.id]: 0, [factB.id]: 1 });
    });

    it('scenariusz 4: archiwizacja jednego członka poza kolejką -> warunek znika -> proposal withdrawn, nic nowego', async () => {
      const before = await findNightlyProposal('merge', [factA.id, factB.id], 'pending');
      expect(before).toBeDefined();

      await db.update(memories).set({ status: 'archived', version: 2 }).where(eq(memories.id, factB.id));

      const { nightly } = buildServices();
      await nightly.run({ actor: 'tester' });

      const [oldAfter] = await db.select().from(proposals).where(eq(proposals.id, before!.id));
      expect(oldAfter.status).toBe('withdrawn');

      const recreated = await findNightlyProposal('merge', [factA.id, factB.id], 'pending');
      expect(recreated).toBeUndefined();
    });
  });

  describe('partycjonowanie (scope/projectId) — nigdy merge między projektami', () => {
    it('ten sam wektor w dwóch różnych projektach nie tworzy wspólnego klastra', async () => {
      const p1 = await projects.createProject('nightly-partition-1');
      const p2 = await projects.createProject('nightly-partition-2');
      const f1 = await seedFactWithVector(p1.project.id, { header: 'P1', body: 'Tresc P1.' }, NEAR);
      const f2 = await seedFactWithVector(p2.project.id, { header: 'P2', body: 'Tresc P2.' }, NEAR);

      const { nightly } = buildServices();
      await nightly.run({ actor: 'tester' });

      const cross = await findNightlyProposal('merge', [f1.id, f2.id]);
      expect(cross).toBeUndefined();
    });
  });

  describe('scenariusz 6: prune (RecencyPruneScorer, progi domyślne)', () => {
    it('fakt stary, nigdy nieodczytany -> delete proposal; fakt świeży -> brak', async () => {
      const created = await projects.createProject('nightly-prune-test');
      const projectId = created.project.id;

      const oldFact = await seedFact(projectId, {
        header: 'Stary, nietkniety fakt',
        body: 'Nikt po niego nie siega.',
        createdAt: daysAgo(40),
        lastAccessedAt: null,
        accessCount: 0,
      });
      const freshFact = await seedFact(projectId, {
        header: 'Swiezy fakt',
        body: 'Dopiero co zapisany.',
        createdAt: new Date(),
        lastAccessedAt: null,
        accessCount: 0,
      });

      const { nightly } = buildServices();
      await nightly.run({ actor: 'tester' });

      const oldProposal = await findNightlyProposal('delete', [oldFact.id]);
      expect(oldProposal).toBeDefined();
      expect((oldProposal!.payload as { memoryId: string }).memoryId).toBe(oldFact.id);
      expect(oldProposal!.baseVersions).toEqual({ [oldFact.id]: 0 });

      const freshProposal = await findNightlyProposal('delete', [freshFact.id]);
      expect(freshProposal).toBeUndefined();
    });
  });

  describe('scenariusz 7: approve produkowanego merge proposala', () => {
    it('ProposalsService.approve materializuje C, archiwizuje D i E, embedding=recomputed', async () => {
      const created = await projects.createProject('nightly-approve-test');
      const projectId = created.project.id;

      const d = await seedFactWithVector(projectId, { header: 'D', body: 'Tresc D nieco dluzsza.' }, NEAR);
      const e = await seedFactWithVector(projectId, { header: 'E', body: 'Tresc E.' }, NEAR);

      const { nightly, proposalsService } = buildServices();
      await nightly.run({ actor: 'tester' });

      const proposalRow = await findNightlyProposal('merge', [d.id, e.id]);
      expect(proposalRow).toBeDefined();

      const result = await proposalsService.approve(proposalRow!.id, { actor: 'tester' });
      expect(result.embedding).toBe('recomputed');
      expect([...result.archivedIds].sort()).toEqual([d.id, e.id].sort());

      const [cRow] = await db.select().from(memories).where(eq(memories.id, result.materializedId!));
      expect(cRow.status).toBe('approved');

      const [dAfter] = await db.select().from(memories).where(eq(memories.id, d.id));
      const [eAfter] = await db.select().from(memories).where(eq(memories.id, e.id));
      expect(dAfter.status).toBe('archived');
      expect(eAfter.status).toBe('archived');
    });
  });

  describe('scenariusz 8: advisory lock — przebieg równoległy jest no-op', () => {
    it('lock zajęty na osobnym kliencie -> run() zwraca skipped-locked z pustymi licznikami + audit', async () => {
      const lockClient = await pool.connect();
      try {
        const { rows } = await lockClient.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [NIGHTLY_LOCK_KEY],
        );
        expect(rows[0]?.locked).toBe(true);

        const { nightly } = buildServices();
        const result = await nightly.run({ actor: 'tester-lock' });

        expect(result.status).toBe('skipped-locked');
        expect(result.counters).toEqual({
          created: 0,
          withdrawn: 0,
          skippedAsDup: 0,
          mergeProposed: 0,
          pruneProposed: 0,
          skippedPoliteness: 0,
          skippedCap: 0,
          searchEventsPruned: 0,
        });

        const auditRow = await audit.latestByEventType('nightly_run');
        expect(auditRow).toBeDefined();
        expect((auditRow!.metadata as { status?: string })?.status).toBe('skipped-locked');
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [NIGHTLY_LOCK_KEY]);
        lockClient.release();
      }
    });
  });

  describe('scenariusz 9: kształt audytu nightly_run zgodny z tym, co czyta MetricsController', () => {
    it('audit_log.metadata niesie {status, startedAt, finishedAt, durationMs, counters:{...}}', async () => {
      const { nightly } = buildServices();
      await nightly.run({ actor: 'tester-shape' });

      const auditRow = await audit.latestByEventType('nightly_run');
      expect(auditRow).toBeDefined();
      const metadata = auditRow!.metadata as Record<string, unknown>;

      expect(metadata).toMatchObject({
        status: expect.any(String),
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
        durationMs: expect.any(Number),
        counters: {
          created: expect.any(Number),
          withdrawn: expect.any(Number),
          skippedAsDup: expect.any(Number),
          mergeProposed: expect.any(Number),
          pruneProposed: expect.any(Number),
          skippedPoliteness: expect.any(Number),
          skippedCap: expect.any(Number),
        },
      });
      // Dokładnie to pole czyta `MetricsController` (`nightlyRun.at`/`nightlyRun.metadata`).
      expect(auditRow!.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('politeness gate (plan §5 pkt 5) — pending proposal spoza nightly blokuje warunek', () => {
    it('fakt z pending human update proposal jest pomijany przez prune do czasu odblokowania', async () => {
      const created = await projects.createProject('nightly-politeness-test');
      const projectId = created.project.id;

      const fact = await seedFact(projectId, {
        header: 'Fakt pod recenzja',
        body: 'Ktos wlasnie edytuje ten fakt.',
        createdAt: daysAgo(40),
        lastAccessedAt: null,
        accessCount: 0,
      });

      await db.insert(proposals).values({
        id: generateId(ID_PREFIX.proposal),
        type: 'update',
        origin: 'human',
        status: 'pending',
        payload: { memoryId: fact.id, header: 'Nowy naglowek' },
        affectedIds: [fact.id],
        baseVersions: { [fact.id]: 0 },
        scope: 'project',
        projectId,
      });

      const { nightly } = buildServices();
      const result = await nightly.run({ actor: 'tester' });

      expect(result.counters.skippedPoliteness).toBeGreaterThanOrEqual(1);
      const pruneProposal = await findNightlyProposal('delete', [fact.id]);
      expect(pruneProposal).toBeUndefined();
    });
  });

  describe('flood backstop (plan §5 pkt 6) — NIGHTLY_MAX_PROPOSALS_PER_RUN', () => {
    it('cap=1 z dwoma niezależnymi warunkami prune -> jeden created, jeden skippedCap, oba wykrywalne w kolejnym biegu', async () => {
      const created = await projects.createProject('nightly-cap-test');
      const projectId = created.project.id;

      const f1 = await seedFact(projectId, {
        header: 'Cap fakt 1',
        body: 'Tresc 1.',
        createdAt: daysAgo(40),
        lastAccessedAt: null,
        accessCount: 0,
      });
      const f2 = await seedFact(projectId, {
        header: 'Cap fakt 2',
        body: 'Tresc 2.',
        createdAt: daysAgo(40),
        lastAccessedAt: null,
        accessCount: 0,
      });

      const { nightly } = buildServices({ NIGHTLY_MAX_PROPOSALS_PER_RUN: 1 });
      const result = await nightly.run({ actor: 'tester' });

      expect(result.counters.created).toBe(1);
      expect(result.counters.skippedCap).toBe(1);

      const p1 = await findNightlyProposal('delete', [f1.id]);
      const p2 = await findNightlyProposal('delete', [f2.id]);
      // Dokładnie jeden z dwóch powstał w tym przebiegu (obcięcie deterministyczne po conditionKey).
      expect([p1 !== undefined, p2 !== undefined].filter(Boolean)).toHaveLength(1);

      // Kolejny przebieg BEZ capa dobija drugi warunek — nic nie zginęło po cichu.
      const { nightly: nightlyUncapped } = buildServices();
      const result2 = await nightlyUncapped.run({ actor: 'tester' });
      expect(result2.counters.created).toBe(1);

      const p1After = await findNightlyProposal('delete', [f1.id]);
      const p2After = await findNightlyProposal('delete', [f2.id]);
      expect(p1After).toBeDefined();
      expect(p2After).toBeDefined();
    });
  });

  describe('flood backstop + replacement pairing (Fix 2) — capped replacement nie osiera withdraw', () => {
    it('stale merge replacement ucięty capem -> stary proposal ZOSTAJE pending (para odłożona w całości)', async () => {
      const created = await projects.createProject('nightly-cap-replace-test');
      const projectId = created.project.id;

      const a = await seedFactWithVector(projectId, { header: 'RA', body: 'Tresc RA.' }, NEAR);
      const b = await seedFactWithVector(projectId, { header: 'RB', body: 'Tresc RB duzo dluzsza.' }, NEAR);

      const { nightly } = buildServices();
      await nightly.run({ actor: 'tester' });

      const before = await findNightlyProposal('merge', [a.id, b.id]);
      expect(before).toBeDefined();

      // Unieważnij istniejący proposal (bump version poza kolejką, jak w scenariuszu 3) -> przy
      // kolejnym biegu wykryty jako "stale", wymaga PARY (withdraw stary + create świeży).
      await db.update(memories).set({ version: 1 }).where(eq(memories.id, b.id));

      // Niezależny, nowy warunek prune. conditionKey zaczyna się od "delete|" < "merge|" ->
      // zawsze wygrywa deterministyczne sortowanie capa (localeCompare), niezależnie od id.
      const pruneFact = await seedFact(projectId, {
        header: 'Cap prune fakt',
        body: 'Tresc prune.',
        createdAt: daysAgo(40),
        lastAccessedAt: null,
        accessCount: 0,
      });

      const { nightly: cappedNightly } = buildServices({ NIGHTLY_MAX_PROPOSALS_PER_RUN: 1 });
      const result = await cappedNightly.run({ actor: 'tester' });

      expect(result.counters.created).toBe(1);
      expect(result.counters.skippedCap).toBe(1);

      // Nowy prune proposal powstał (wygrał cap dzięki sortowaniu po conditionKey).
      const pruneProposal = await findNightlyProposal('delete', [pruneFact.id]);
      expect(pruneProposal).toBeDefined();

      // KLUCZOWA ASERCJA (Fix 2): stary merge proposal NIE został wycofany, mimo że jego warunek
      // jest "stale" — para (withdraw+create) została odłożona w CAŁOŚCI, bo jej `create` przegrał
      // cap. Bez fixa: stary proposal ginąłby z kolejki, a jego zastąpienie by nie powstało.
      const [oldStillPending] = await db.select().from(proposals).where(eq(proposals.id, before!.id));
      expect(oldStillPending.status).toBe('pending');

      const stillTheOldOne = await findNightlyProposal('merge', [a.id, b.id], 'pending');
      expect(stillTheOldOne!.id).toBe(before!.id);

      // Kolejny bieg bez capa -> teraz para replace przechodzi w całości.
      const { nightly: uncappedNightly } = buildServices();
      await uncappedNightly.run({ actor: 'tester' });

      const [oldAfter] = await db.select().from(proposals).where(eq(proposals.id, before!.id));
      expect(oldAfter.status).toBe('withdrawn');

      const fresh = await findNightlyProposal('merge', [a.id, b.id], 'pending');
      expect(fresh).toBeDefined();
      expect(fresh!.id).not.toBe(before!.id);
      expect(fresh!.baseVersions).toEqual({ [a.id]: 0, [b.id]: 1 });
    });
  });

  describe('withdraw guard — origin/status', () => {
    it('proposal spoza nightly nigdy nie jest widoczny dla reconcile jako "existing nightly" (brak withdraw human proposala)', async () => {
      const created = await projects.createProject('nightly-guard-test');
      const projectId = created.project.id;
      const fact = await seedFact(projectId, { header: 'Guard fakt', body: 'Tresc.' });

      const [humanProposal] = await db
        .insert(proposals)
        .values({
          id: generateId(ID_PREFIX.proposal),
          type: 'delete',
          origin: 'human',
          status: 'pending',
          payload: { memoryId: fact.id },
          affectedIds: [fact.id],
          baseVersions: { [fact.id]: 0 },
          scope: 'project',
          projectId,
        })
        .returning();

      const { nightly } = buildServices();
      await nightly.run({ actor: 'tester' });

      const [after] = await db.select().from(proposals).where(eq(proposals.id, humanProposal.id));
      expect(after.status).toBe('pending'); // nietknięty — nightly nigdy nie dotyka proposali innego origin
    });
  });
});
