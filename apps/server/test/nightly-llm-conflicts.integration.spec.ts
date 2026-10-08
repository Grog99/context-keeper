import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { generateId, ID_PREFIX } from '../src/common/ids';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import {
  EMBEDDING_DIM,
  auditLog,
  embeddings,
  llmSettings,
  memories,
  proposals,
  revisions,
  type MemoryRow,
  type NewMemoryRow,
  type ProposalRow,
} from '../src/db/schema';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { LlmSettingsService } from '../src/llm/llm-settings.service';
import type { LlmProvider } from '../src/llm/llm-provider';
import { LlmService } from '../src/llm/llm.service';
import { LLM_GLOBAL_SETTINGS_ID } from '../src/llm/llm.constants';
import type { LlmChatMessage, LlmChatResult, LlmEndpoint } from '../src/llm/llm.types';
import { runLlmConflicts } from '../src/nightly/llm-conflicts';
import { NightlyService } from '../src/nightly/nightly.service';
import { RecencyPruneScorer } from '../src/nightly/prune-scorer';
import { ProposalsService } from '../src/proposals/proposals.service';
import type { DeletePayload } from '../src/proposals/proposals.types';
import { UsageService } from '../src/usage/usage.service';
import { buildProjectsService } from './helpers/services';

// Zachowuje prawdziwą implementację; AC15 podmienia ją jednorazowo, żeby wywołać wyjątek POZA budżetem.
vi.mock('../src/nightly/llm-conflicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/nightly/llm-conflicts')>();
  return { ...actual, runLlmConflicts: vi.fn(actual.runLlmConflicts) };
});

/**
 * Detektor sprzeczności w nocnym jobie (roadmap v1.6 B3, ticket nightly-conflicts-report) — pełny przebieg
 * `NightlyService.run()` + `ProposalsService` (approve / swap) na prawdziwym Postgresie (testcontainers) z FAKE
 * providerem LLM wstrzykniętym przez DI. Żaden test nie dotyka sieci: `globalThis.fetch` jest szpiegowany i nie
 * może zostać wywołany. Własny kontener, żeby liczniki wywołań były dokładne. Pasmo ustawione na 0.3
 * (`NIGHTLY_CONFLICT_DISTANCE`), dedup 0.05; para w paśmie ma dystans 0.15.
 */

const ACTIVE_MODEL = 'nightly-llm-conflicts-test-model';
const ENDPOINT_URL = 'http://fake.invalid/v1/chat/completions';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);
const hoursAgo = (n: number): Date => new Date(Date.now() - n * HOUR_MS);
const BAND_ENV = { NIGHTLY_CONFLICT_DISTANCE: '0.3' };

const LLM_ZEROS = {
  llmCalls: 0,
  llmErrors: 0,
  llmSkippedCap: 0,
  llmSkippedBreaker: 0,
  llmSkippedSecret: 0,
  llmSkippedKeyUnreadable: 0,
};
const LLM_PRUNE_ZEROS = { llmPruneCandidates: 0, llmPruneKept: 0, llmPruneDeleteProposed: 0, llmPruneUpdateProposed: 0 };
const LLM_CONFLICT_ZEROS = { llmConflictCandidates: 0, llmConflictConsistent: 0, llmConflictProposed: 0 };

class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;
  constructor(public model: string) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(EMBEDDING_DIM).fill(0.01));
  }
  async health(): Promise<boolean> {
    return true;
  }
}

/** Wersor osi `i`. */
function axis(i: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[i] = 1;
  return v;
}
/** Wektor jednostkowy z `c` na osi `i` i √(1−c²) na osi `j` (znak `sign`): dystans do `axis(i)` = 1 − c. */
function vecAt(i: number, j: number, c: number, sign = 1): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[i] = c;
  v[j] = sign * Math.sqrt(1 - c * c);
  return v;
}
/** dist 0.15 (w paśmie 0.05–0.3). */
const C_BAND = 0.85;

const json = (o: unknown): string => JSON.stringify(o);
const headerOf = (user: string): string => /^header: (.*)$/m.exec(user)?.[1] ?? '';

/**
 * Fake LLM: wiadomość z `<entry_a>` to sąd konfliktu (sprzeczne, gdy któryś nagłówek ma `[CONFLICT]`), każda inna
 * (`<entry>`) to prune (`delete` dla `[EPHEMERAL]`, inaczej `keep`). Liczy osobno wywołania konfliktowe.
 */
class FakeLlmProvider implements LlmProvider {
  readonly users: string[] = [];
  conflictOverride?: (user: string) => string | Error;

  get conflictUsers(): string[] {
    return this.users.filter((u) => u.includes('<entry_a>'));
  }
  get conflictCalls(): number {
    return this.conflictUsers.length;
  }
  get pruneCalls(): number {
    return this.users.length - this.conflictCalls;
  }
  get calls(): number {
    return this.users.length;
  }

  async chat(_endpoint: LlmEndpoint, messages: LlmChatMessage[]): Promise<LlmChatResult> {
    const user = messages[messages.length - 1].content;
    this.users.push(user);
    let out: string | Error;
    if (user.includes('<entry_a>')) {
      out =
        this.conflictOverride?.(user) ??
        (user.includes('[CONFLICT]')
          ? json({ contradiction: true, reason: 'Dwa różne porty dla tej samej usługi.' })
          : json({ contradiction: false, reason: null }));
    } else {
      out = headerOf(user).includes('[EPHEMERAL]')
        ? json({ verdict: 'delete', category: 'ephemeral', reason: 'Notatka o bieżącej pracy.' })
        : json({ verdict: 'keep' });
    }
    if (out instanceof Error) throw out;
    return { content: out, model: 'fake', latencyMs: 1 };
  }
}

describe('Detektor sprzeczności w nocnym jobie (integration, testcontainers) — roadmap v1.6 B3', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let audit: AuditService;
  let projectId: string;
  let otherProjectId: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let nextAxis = 10;

  function build(fake: FakeLlmProvider, envOverrides: Record<string, unknown> = {}) {
    const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused', ...BAND_ENV, ...envOverrides }));
    const embedding = new EmbeddingService(new StubEmbeddingProvider(ACTIVE_MODEL), config);
    const settings = new LlmSettingsService(db, config, audit);
    const llm = new LlmService(settings, fake, audit);
    const nightly = new NightlyService(db, pool, config, audit, embedding, new RecencyPruneScorer(), new UsageService(db), llm);
    const proposalsService = new ProposalsService(db, config, audit, embedding);
    return { config, nightly, proposalsService };
  }

  async function enableLlm(opts: { windowDays?: number; cap?: number } = {}): Promise<void> {
    await db
      .update(llmSettings)
      .set({
        enabled: true,
        endpoint: ENDPOINT_URL,
        model: 'fake',
        callCap: opts.cap ?? 100,
        scanWindowDays: opts.windowDays ?? 1,
        apiKeyCiphertext: null,
      })
      .where(eq(llmSettings.id, LLM_GLOBAL_SETTINGS_ID));
  }

  async function seedFact(overrides: Partial<NewMemoryRow> = {}): Promise<MemoryRow> {
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

  /** Para w paśmie (domyślnie dist 0.15) na świeżej osi: starszy (10 dni) + nowszy (teraz), oba z wektorem. */
  async function seedPair(
    opts: {
      older?: Partial<NewMemoryRow>;
      newer?: Partial<NewMemoryRow>;
      c?: number;
      sign?: number;
      sharedAxis?: number;
    } = {},
  ): Promise<{ older: MemoryRow; newer: MemoryRow; axisIdx: number }> {
    const axisIdx = opts.sharedAxis ?? (nextAxis += 3);
    const older = await seedFact({ header: 'Stary wpis', body: 'Port 3000.', createdAt: daysAgo(10), ...opts.older });
    const newer = await seedFact({ header: '[CONFLICT] Nowy wpis', body: 'Port 8080.', ...opts.newer });
    await seedVector(older.id, axis(axisIdx));
    await seedVector(newer.id, vecAt(axisIdx, axisIdx + 1, opts.c ?? C_BAND, opts.sign ?? 1));
    return { older, newer, axisIdx };
  }

  async function insertProposal(
    overrides: Partial<ProposalRow> & Pick<ProposalRow, 'type' | 'origin' | 'affectedIds'>,
  ): Promise<ProposalRow> {
    const [row] = await db
      .insert(proposals)
      .values({
        id: generateId(ID_PREFIX.proposal),
        status: 'pending',
        payload: { memoryId: overrides.affectedIds[0] },
        baseVersions: Object.fromEntries(overrides.affectedIds.map((id) => [id, 0])),
        contentHash: null,
        scope: 'project',
        projectId,
        ...overrides,
      })
      .returning();
    return row;
  }

  async function pendingNightly(type?: ProposalRow['type']): Promise<ProposalRow[]> {
    const conditions = [eq(proposals.origin, 'nightly'), eq(proposals.status, 'pending')];
    if (type) conditions.push(eq(proposals.type, type));
    return db.select().from(proposals).where(and(...conditions));
  }

  async function conflictProposals(): Promise<ProposalRow[]> {
    return (await pendingNightly('delete')).filter((p) => p.affectedIds.length === 2);
  }

  async function onlyConflict(): Promise<ProposalRow> {
    const rows = await conflictProposals();
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function getMemory(id: string): Promise<MemoryRow> {
    const [row] = await db.select().from(memories).where(eq(memories.id, id));
    return row;
  }

  async function proposalRow(id: string): Promise<ProposalRow> {
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id));
    return row;
  }

  async function swapAudits(): Promise<Array<{ metadata: unknown; affectedIds: string[] }>> {
    return db
      .select({ metadata: auditLog.metadata, affectedIds: auditLog.affectedIds })
      .from(auditLog)
      .where(and(eq(auditLog.eventType, 'proposal_edited'), sql`${auditLog.metadata} @> '{"action":"swap_direction"}'::jsonb`));
  }

  async function archiveRevisions(memoryId: string): Promise<number> {
    const rows = await db
      .select({ id: revisions.id })
      .from(revisions)
      .where(and(eq(revisions.memoryId, memoryId), eq(revisions.action, 'archive')));
    return rows.length;
  }

  async function lastRunCounters(): Promise<Record<string, number>> {
    const row = await audit.latestByEventType('nightly_run');
    return (row!.metadata as { counters: Record<string, number> }).counters;
  }

  /** Uruchamia przebieg z włączonym krokiem i zwraca jedyną propozycję konfliktu. */
  async function detectOneConflict(opts: Parameters<typeof seedPair>[0] = {}) {
    const pair = await seedPair(opts);
    await enableLlm();
    const fake = new FakeLlmProvider();
    const services = build(fake);
    await services.nightly.run({ actor: 'tester' });
    return { ...pair, fake, ...services, proposal: await onlyConflict() };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
    audit = new AuditService(db);
    const projects = buildProjectsService(db, config);
    projectId = (await projects.createProject('llm-conflicts-test')).project.id;
    otherProjectId = (await projects.createProject('llm-conflicts-other')).project.id;
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE memories, proposals, audit_log CASCADE');
    await db
      .update(llmSettings)
      .set({ enabled: false, endpoint: null, model: null, apiKeyCiphertext: null, callCap: 100, timeoutMs: 30000, scanWindowDays: 1 })
      .where(eq(llmSettings.id, LLM_GLOBAL_SETTINGS_ID));
    nextAxis = 10;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    // Żaden test nie sięga do sieci — wszystko idzie przez fake providera.
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // ---- AC 1: wyłączony krok = dzisiejszy przebieg ---------------------------------------------

  it('AC1: krok wyłączony -> te same proposale i liczniki co przed B3 (pasmo puste, 0 wywołań, liczniki sprzeczności = 0)', async () => {
    await seedPair(); // para w paśmie
    const a = await seedFact({ header: 'Dedup A' });
    const b = await seedFact({ header: 'Dedup B' });
    await seedVector(a.id, axis(40));
    await seedVector(b.id, vecAt(40, 41, 0.97)); // dist 0.03
    await seedFact({ header: 'Stary nietknięty', createdAt: daysAgo(40) });
    const fake = new FakeLlmProvider();

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(result.counters).toEqual({
      created: 2,
      withdrawn: 0,
      skippedAsDup: 0,
      mergeProposed: 1,
      pruneProposed: 1,
      skippedPoliteness: 0,
      skippedCap: 0,
      searchEventsPruned: 0,
      ...LLM_ZEROS,
      ...LLM_PRUNE_ZEROS,
      ...LLM_CONFLICT_ZEROS,
    });
    expect(fake.calls).toBe(0);
    expect(await conflictProposals()).toEqual([]);
  });

  // ---- AC 2: sprzeczność -> pending delete na starszym ----------------------------------------

  it('AC2: sprzeczna para -> pending delete (origin nightly) na STARSZYM, z counterpartId, posortowanymi affectedIds, baseVersions i rationale', async () => {
    const { older, newer, fake, proposal } = await detectOneConflict();

    expect(proposal.origin).toBe('nightly');
    expect(proposal.status).toBe('pending');
    expect(proposal.affectedIds).toEqual([older.id, newer.id].sort());
    expect(proposal.baseVersions).toEqual({ [older.id]: 0, [newer.id]: 0 });
    expect(proposal.scope).toBe('project');
    expect(proposal.projectId).toBe(projectId);
    expect(proposal.editedPayload).toBeNull();
    expect(proposal.payload).toEqual({
      memoryId: older.id,
      counterpartId: newer.id,
      rationale: {
        detector: 'llm-conflicts',
        category: 'contradiction',
        reason: 'Dwa różne porty dla tej samej usługi.',
      },
    });
    expect(fake.conflictCalls).toBe(1);
    // Audyt `proposal_created` niesie detektor i kategorię.
    const created = await audit.latestByEventType('proposal_created', { detector: 'llm-conflicts' });
    expect(created).toBeDefined();
    expect(created!.metadata).toMatchObject({ detector: 'llm-conflicts', category: 'contradiction', type: 'delete' });
  });

  // ---- AC 3: niesprzeczne -> brak proposala -----------------------------------------------------

  it('AC3: para uznana za niesprzeczną nie daje proposala; llmConflictConsistent = 1', async () => {
    await seedPair({ newer: { header: 'Nowy wpis bez znacznika' } });
    await enableLlm();
    const fake = new FakeLlmProvider();

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(await conflictProposals()).toEqual([]);
    expect(fake.conflictCalls).toBe(1);
    expect(result.counters).toMatchObject({
      llmConflictCandidates: 1,
      llmConflictConsistent: 1,
      llmConflictProposed: 0,
    });
  });

  // ---- AC 4: dedup -> merge; poza pasmem nie wołane ------------------------------------------------

  it('AC4: dist <= dedup -> merge i 0 wywołań konfliktu; dist > NIGHTLY_CONFLICT_DISTANCE -> 0 wywołań', async () => {
    const dedupPair = await seedPair({ c: 0.97 }); // dist 0.03 -> klaster merge
    const farPair = await seedPair({ c: 0.5 }); // dist 0.5 > 0.3
    await enableLlm();
    const fake = new FakeLlmProvider();

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(fake.conflictCalls).toBe(0);
    expect(result.counters).toMatchObject({ mergeProposed: 1, llmConflictCandidates: 0, llmConflictProposed: 0 });
    const merges = await pendingNightly('merge');
    expect(merges).toHaveLength(1);
    expect([...merges[0].affectedIds].sort()).toEqual([dedupPair.older.id, dedupPair.newer.id].sort());
    expect(farPair.older.id).toBeDefined();
  });

  // ---- AC 5: granice partycji i okna ---------------------------------------------------------------

  it('AC5: inny projekt / granica global-project / obie strony poza oknem -> 0 wywołań', async () => {
    // inny projekt
    const cross = await seedPair({ older: { projectId: otherProjectId } });
    expect(cross.older.projectId).not.toBe(cross.newer.projectId);
    // granica global/project
    await seedPair({ older: { scope: 'global', projectId: null } });
    // obie strony stare (poza oknem 1 dnia)
    await seedPair({ newer: { createdAt: daysAgo(5) } });
    await enableLlm();
    const fake = new FakeLlmProvider();

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(fake.conflictCalls).toBe(0);
    expect(result.counters).toMatchObject({ llmConflictCandidates: 0 });
    expect(await conflictProposals()).toEqual([]);
  });

  // ---- AC 6: wyłączenia z ust. 22 -------------------------------------------------------------------

  it('AC6 (ust. 22): strona w klastrze merge / kwalifikująca się do recency / z pending proposalem / z warunkiem LLM prune -> 0 wywołań konfliktu', async () => {
    // a) strona w klastrze merge: F i G (dist 0.03) + nowy H w paśmie od F (0.15) i od G (~0.1755)
    const axisA = 60;
    const f = await seedFact({ header: 'Klaster F', createdAt: daysAgo(10) });
    const g = await seedFact({ header: 'Klaster G', createdAt: daysAgo(10) });
    const h = await seedFact({ header: '[CONFLICT] H w paśmie klastra' });
    await seedVector(f.id, axis(axisA));
    await seedVector(g.id, vecAt(axisA, axisA + 1, 0.97));
    await seedVector(h.id, vecAt(axisA, axisA + 2, C_BAND));

    // b) strona kwalifikująca się do recency prune (40 dni, nigdy nieodczytana)
    await seedPair({ older: { header: 'Recency kandydat', createdAt: daysAgo(40) } });

    // c) strona z pending proposalem (człowiek)
    const pending = await seedPair({ older: { header: 'Ma pending' } });
    await insertProposal({ type: 'update', origin: 'human', affectedIds: [pending.older.id], payload: { memoryId: pending.older.id, body: 'x' } });

    // d) nowsza strona dostaje warunek z LLM prune ([EPHEMERAL])
    await seedPair({ newer: { header: '[EPHEMERAL] [CONFLICT] notatka z sesji' } });

    await enableLlm();
    const fake = new FakeLlmProvider();

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(fake.conflictCalls).toBe(0);
    expect(result.counters).toMatchObject({ llmConflictCandidates: 0, llmConflictProposed: 0, mergeProposed: 1, llmPruneDeleteProposed: 1 });
    expect(await conflictProposals()).toEqual([]);
  });

  // ---- AC 7: obie strony w oknie -> jedna para ------------------------------------------------------

  it('AC7: ta sama para wykryta z obu końców (obie strony w oknie) daje jedno wywołanie i jeden proposal', async () => {
    const { older } = await seedPair({ older: { createdAt: hoursAgo(2) } });
    await enableLlm();
    const fake = new FakeLlmProvider();

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(fake.conflictCalls).toBe(1);
    expect(result.counters).toMatchObject({ llmConflictCandidates: 1, llmConflictProposed: 1 });
    const proposal = await onlyConflict();
    expect((proposal.payload as DeletePayload).memoryId).toBe(older.id);
  });

  // ---- AC 8: G1 wspólny cap, prune najpierw ------------------------------------------------------------

  it('AC8 (G1): cap wyczerpany przez prune -> conflicts nie woła modelu, nadwyżka w llmSkippedCap, brak proposala', async () => {
    await seedPair(); // nowszy wpis jest faktem z okna
    await seedFact({ header: 'Inny fakt z okna' }); // drugi fakt z okna
    await enableLlm({ cap: 2 });
    const fake = new FakeLlmProvider();

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(fake.pruneCalls).toBe(2);
    expect(fake.conflictCalls).toBe(0);
    expect(result.counters).toMatchObject({
      llmCalls: 2,
      llmConflictCandidates: 1,
      llmConflictConsistent: 0,
      llmConflictProposed: 0,
    });
    expect(result.counters.llmSkippedCap).toBeGreaterThanOrEqual(1);
    expect(await conflictProposals()).toEqual([]);
  });

  // ---- AC 9: dane dla kolejki -----------------------------------------------------------------------------

  it('AC9: getProposal niesie payload.counterpartId + rationale, a listPendingPage summary.counterpartId', async () => {
    const { older, newer, proposal, proposalsService } = await detectOneConflict();

    const view = await proposalsService.getProposal(proposal.id);
    expect(view.payload).toMatchObject({
      memoryId: older.id,
      counterpartId: newer.id,
      rationale: { detector: 'llm-conflicts', category: 'contradiction' },
    });
    expect(view.stale).toBe(false);

    const page = await proposalsService.listPendingPage();
    const item = page.items.find((i) => i.id === proposal.id);
    expect(item?.summary.memoryId).toBe(older.id);
    expect(item?.summary.counterpartId).toBe(newer.id);
    expect(item?.edited).toBe(false);
  });

  // ---- AC 10: approve archiwizuje wyłącznie target ---------------------------------------------------------

  it('AC10: approve archiwizuje wyłącznie starszy wpis; kontrpartner zachowuje status i wersję', async () => {
    const { older, newer, proposal, proposalsService } = await detectOneConflict();

    const result = await proposalsService.approve(proposal.id, { actor: 'tester' });

    expect(result.archivedIds).toEqual([older.id]);
    expect((await getMemory(older.id)).status).toBe('archived');
    const counterpart = await getMemory(newer.id);
    expect(counterpart.status).toBe('approved');
    expect(counterpart.version).toBe(0);
    expect(await archiveRevisions(older.id)).toBe(1);
    expect(await archiveRevisions(newer.id)).toBe(0);
  });

  it('AC10 (obrona w głąb): approve delete z celem spoza affectedIds -> validation_error, nic nie zarchiwizowane', async () => {
    const a = await seedFact({ header: 'A' });
    const b = await seedFact({ header: 'B' });
    const { proposalsService } = build(new FakeLlmProvider());
    const outside = await insertProposal({ type: 'delete', origin: 'nightly', affectedIds: [a.id], payload: { memoryId: b.id } });
    const conflictMismatch = await insertProposal({
      type: 'delete',
      origin: 'nightly',
      affectedIds: [a.id, b.id],
      payload: { memoryId: a.id, counterpartId: a.id, rationale: { detector: 'llm-conflicts', category: 'contradiction', reason: 'r' } },
    });

    await expect(proposalsService.approve(outside.id, { actor: 'tester' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(proposalsService.approve(conflictMismatch.id, { actor: 'tester' })).rejects.toMatchObject({ code: 'validation_error' });
    expect((await getMemory(a.id)).status).toBe('approved');
    expect((await getMemory(b.id)).status).toBe('approved');
  });

  // ---- AC 11: zamiana kierunku (G3) ----------------------------------------------------------------------------

  it('AC11 (G3): swap -> approve archiwizuje nowszy, starszy nietknięty; audyt proposal_edited/swap_direction; edited_payload czyszczony przy powrocie', async () => {
    const { older, newer, proposal, proposalsService } = await detectOneConflict();

    const swapped = await proposalsService.swapConflictDirection(proposal.id, newer.id, { actor: 'tester' });
    expect(swapped).toEqual({ memoryId: newer.id, counterpartId: older.id });

    const row = await proposalRow(proposal.id);
    expect(row.payload).toMatchObject({ memoryId: older.id }); // oryginał detektora nietknięty
    expect(row.editedPayload).toEqual({
      memoryId: newer.id,
      counterpartId: older.id,
      rationale: { detector: 'llm-conflicts', category: 'contradiction', reason: 'Dwa różne porty dla tej samej usługi.' },
    });
    expect(row.affectedIds).toEqual([older.id, newer.id].sort());
    const audits = await swapAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({
      proposalId: proposal.id,
      action: 'swap_direction',
      fromMemoryId: older.id,
      toMemoryId: newer.id,
    });

    // lista i widok odzwierciedlają zamianę
    const item = (await proposalsService.listPendingPage()).items.find((i) => i.id === proposal.id);
    expect(item?.summary.memoryId).toBe(newer.id);
    expect(item?.summary.counterpartId).toBe(older.id);
    expect(item?.edited).toBe(true);

    // ponowna zamiana na aktualny cel = no-op bez zapisu i bez audytu
    await proposalsService.swapConflictDirection(proposal.id, newer.id, { actor: 'tester' });
    expect(await swapAudits()).toHaveLength(1);

    // powrót do kierunku z detektora czyści „edytowano"
    await proposalsService.swapConflictDirection(proposal.id, older.id, { actor: 'tester' });
    expect((await proposalRow(proposal.id)).editedPayload).toBeNull();
    expect(await swapAudits()).toHaveLength(2);

    // znów na nowszy i approve
    await proposalsService.swapConflictDirection(proposal.id, newer.id, { actor: 'tester' });
    const result = await proposalsService.approve(proposal.id, { actor: 'tester' });
    expect(result.archivedIds).toEqual([newer.id]);
    expect((await getMemory(newer.id)).status).toBe('archived');
    const keptOlder = await getMemory(older.id);
    expect(keptOlder.status).toBe('approved');
    expect(keptOlder.version).toBe(0);
    expect(await archiveRevisions(older.id)).toBe(0);
  });

  it('AC11: swap odrzuca id spoza affectedIds oraz propozycje, które nie są z detektora sprzeczności', async () => {
    const { older, proposal, proposalsService } = await detectOneConflict();
    const stranger = await seedFact({ header: 'Obcy' });

    await expect(proposalsService.swapConflictDirection(proposal.id, stranger.id, { actor: 'tester' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect((await proposalRow(proposal.id)).editedPayload).toBeNull();

    const recency = await insertProposal({ type: 'delete', origin: 'nightly', affectedIds: [stranger.id], payload: { memoryId: stranger.id } });
    const update = await insertProposal({ type: 'update', origin: 'agent', affectedIds: [older.id], payload: { memoryId: older.id, body: 'x' } });
    const merge = await insertProposal({
      type: 'merge',
      origin: 'nightly',
      affectedIds: [older.id, stranger.id],
      payload: { memoryId: 'mem_c', header: 'h', body: 'b', tags: [], kind: 'fact' },
    });
    for (const p of [recency, update, merge]) {
      await expect(proposalsService.swapConflictDirection(p.id, p.affectedIds[0], { actor: 'tester' })).rejects.toMatchObject({
        code: 'validation_error',
      });
    }
    await expect(proposalsService.swapConflictDirection('prop_doesnotexist0', older.id, { actor: 'tester' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await swapAudits()).toEqual([]);
  });

  it('AC11: swap na zdecydowanej propozycji -> already_decided', async () => {
    const { older, newer, proposal, proposalsService } = await detectOneConflict();
    await proposalsService.reject(proposal.id, { actor: 'tester' });

    await expect(proposalsService.swapConflictDirection(proposal.id, newer.id, { actor: 'tester' })).rejects.toMatchObject({
      code: 'already_decided',
    });
    expect(older.id).toBeDefined();
  });

  it('AC11: bulk approve po zamianie archiwizuje nowszy wpis', async () => {
    const { older, newer, proposal, proposalsService } = await detectOneConflict();
    await proposalsService.swapConflictDirection(proposal.id, newer.id, { actor: 'tester' });

    const result = await proposalsService.bulkApprove([proposal.id], { actor: 'tester' });

    expect(result).toEqual({ succeeded: [proposal.id], failed: [] });
    expect((await getMemory(newer.id)).status).toBe('archived');
    expect((await getMemory(older.id)).status).toBe('approved');
  });

  // ---- AC 12: edycja po wykryciu -> stale --------------------------------------------------------------------------

  it('AC12: zmiana kontrpartnera (albo targetu) po wykryciu czyni proposal stale — także po zamianie kierunku', async () => {
    const first = await detectOneConflict();
    await pool.query('UPDATE memories SET version = version + 1 WHERE id = $1', [first.newer.id]);
    expect((await first.proposalsService.getProposal(first.proposal.id)).stale).toBe(true);
    await expect(first.proposalsService.approve(first.proposal.id, { actor: 'tester' })).rejects.toMatchObject({
      code: 'stale',
      staleIds: [first.newer.id],
    });
    expect((await getMemory(first.older.id)).status).toBe('approved');

    // po zamianie kierunku: bump drugiej strony (teraz kontrpartnera = starszy)
    await pool.query('TRUNCATE memories, proposals, audit_log CASCADE');
    const second = await detectOneConflict();
    await second.proposalsService.swapConflictDirection(second.proposal.id, second.newer.id, { actor: 'tester' });
    await pool.query('UPDATE memories SET version = version + 1 WHERE id = $1', [second.older.id]);
    await expect(second.proposalsService.approve(second.proposal.id, { actor: 'tester' })).rejects.toMatchObject({ code: 'stale' });
    expect((await getMemory(second.newer.id)).status).toBe('approved');

    // zmiana obu stron -> obie w staleIds
    await pool.query('UPDATE memories SET version = version + 1 WHERE id = $1', [second.newer.id]);
    await expect(second.proposalsService.approve(second.proposal.id, { actor: 'tester' })).rejects.toMatchObject({
      code: 'stale',
      staleIds: [second.older.id, second.newer.id].sort(),
    });
  });

  // ---- AC 13: przeżywa wyjście kotwicy z okna; brak duplikatów ------------------------------------------------------

  it('AC13: pending konflikt przeżywa przebieg, w którym kotwica jest poza oknem; kolejne przebiegi nie dublują i nie wołają modelu', async () => {
    const { newer, proposal, nightly, fake } = await detectOneConflict();
    expect(fake.conflictCalls).toBe(1);

    // drugi przebieg tego samego dnia: para ma pending proposal -> wyłączona (ust. 22), 0 nowych wywołań konfliktu
    const second = await nightly.run({ actor: 'tester' });
    expect(second.counters).toMatchObject({ created: 0, withdrawn: 0, llmConflictCandidates: 0 });
    expect(fake.conflictCalls).toBe(1);
    expect(await conflictProposals()).toHaveLength(1);

    // kotwica wychodzi z okna: nowszy wpis ma teraz 5 dni -> para poza oknem, a proposal NIE jest wycofany (wyłączony z orphan-withdraw)
    await db.update(memories).set({ createdAt: daysAgo(5) }).where(eq(memories.id, newer.id));
    const third = await nightly.run({ actor: 'tester' });
    expect(third.counters).toMatchObject({ created: 0, withdrawn: 0, llmConflictCandidates: 0 });
    expect(fake.conflictCalls).toBe(1);
    const survivors = await conflictProposals();
    expect(survivors.map((p) => p.id)).toEqual([proposal.id]);
  });

  // ---- AC 14: zawężone orphan-withdraw ------------------------------------------------------------------------------

  it('AC14: dwa konflikty na tym samym starszym wpisie — po approve jednego drugi jest wycofywany (strona nie jest już approved)', async () => {
    const axisIdx = 80;
    const x = await seedFact({ header: 'Wspólny starszy', body: 'Port 3000.', createdAt: daysAgo(10) });
    const y = await seedFact({ header: '[CONFLICT] Y', body: 'Port 8080.' });
    const z = await seedFact({ header: '[CONFLICT] Z', body: 'Port 9090.' });
    await seedVector(x.id, axis(axisIdx));
    await seedVector(y.id, vecAt(axisIdx, axisIdx + 1, C_BAND)); // dist od X 0.15
    await seedVector(z.id, vecAt(axisIdx, axisIdx + 1, C_BAND, -1)); // dist od X 0.15, od Y 0.555 (poza pasmem)
    await enableLlm();
    const fake = new FakeLlmProvider();
    const { nightly, proposalsService } = build(fake);

    await nightly.run({ actor: 'tester' });
    const found = await conflictProposals();
    expect(found).toHaveLength(2);
    expect(found.every((p) => (p.payload as DeletePayload).memoryId === x.id)).toBe(true);

    await proposalsService.approve(found[0].id, { actor: 'tester' });
    expect((await getMemory(x.id)).status).toBe('archived');

    const result = await nightly.run({ actor: 'tester' });

    expect(result.counters.withdrawn).toBe(1);
    expect((await proposalRow(found[1].id)).status).toBe('withdrawn');
    expect(await conflictProposals()).toEqual([]);
  });

  // ---- AC 15: fail-open -------------------------------------------------------------------------------------------------

  it('AC15 (siatka bezpieczeństwa): wyjątek w detektorze sprzeczności -> status success, merge/recency/prune zapisane', async () => {
    const a = await seedFact({ header: 'Dedup A' });
    const b = await seedFact({ header: 'Dedup B' });
    await seedVector(a.id, axis(40));
    await seedVector(b.id, vecAt(40, 41, 0.97));
    const old = await seedFact({ header: 'Recency', createdAt: daysAgo(40) });
    await seedPair();
    await enableLlm();
    vi.mocked(runLlmConflicts).mockRejectedValueOnce(new Error('x'));
    const fake = new FakeLlmProvider();

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(result.status).toBe('success');
    expect(result.counters).toMatchObject({ mergeProposed: 1, pruneProposed: 1, llmConflictProposed: 0, llmConflictConsistent: 0 });
    expect((await pendingNightly('delete')).some((p) => p.affectedIds.length === 1 && p.affectedIds[0] === old.id)).toBe(true);
    expect(await conflictProposals()).toEqual([]);
  });

  it('AC15 (wariant): błąd odczytu pending (kontekst LLM) -> oba detektory LLM pominięte, przebieg success', async () => {
    await seedPair();
    await enableLlm();
    const fake = new FakeLlmProvider();
    const { nightly } = build(fake);
    vi.spyOn(nightly as unknown as { loadPendingAffectedIds: () => Promise<Set<string>> }, 'loadPendingAffectedIds').mockRejectedValue(
      new Error('x'),
    );

    const result = await nightly.run({ actor: 'tester' });

    expect(result.status).toBe('success');
    expect(result.counters).toMatchObject({ llmCalls: 0, llmPruneCandidates: 0, llmConflictCandidates: 0 });
    expect(fake.calls).toBe(0);
  });

  // ---- AC 16: liczniki rozróżnialne -----------------------------------------------------------------------------------------

  it('AC16: nightly_run.metadata.counters ma llmConflict* osobno od llmPrune*', async () => {
    await detectOneConflict();

    const counters = await lastRunCounters();

    expect(counters).toMatchObject({
      created: 1,
      pruneProposed: 0,
      llmPruneCandidates: 1, // nowszy wpis jest faktem z okna
      llmPruneKept: 1,
      llmPruneDeleteProposed: 0,
      llmConflictCandidates: 1,
      llmConflictConsistent: 0,
      llmConflictProposed: 1,
      llmCalls: 2,
    });
  });
});
