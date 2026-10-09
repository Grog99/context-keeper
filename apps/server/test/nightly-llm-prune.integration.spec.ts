import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { generateId, ID_PREFIX } from '../src/common/ids';
import { createSecretBox } from '../src/common/secret-box';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import {
  EMBEDDING_DIM,
  embeddings,
  llmSettings,
  memories,
  proposals,
  revisions,
  type MemoryRow,
  type NewMemoryRow,
  type ProposalRow,
} from '../src/db/schema';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { LlmNetworkError, LlmTimeoutError } from '../src/llm/llm-provider';
import { LlmSettingsService } from '../src/llm/llm-settings.service';
import { LlmService } from '../src/llm/llm.service';
import { LLM_API_KEY_AAD, LLM_GLOBAL_SETTINGS_ID } from '../src/llm/llm.constants';
import { NightlyService } from '../src/nightly/nightly.service';
import { RecencyPruneScorer } from '../src/nightly/prune-scorer';
import { ProposalsService } from '../src/proposals/proposals.service';
import { UsageService } from '../src/usage/usage.service';
import { FakeLlmProvider, headerOf, StubEmbeddingProvider } from './helpers/fakes';
import { buildProjectsService } from './helpers/services';

/**
 * Detektor LLM prune (roadmap v1.6 B2, ticket nightly-llm-prune) — pełny przebieg `NightlyService.run()` na
 * prawdziwym Postgresie (testcontainers) z FAKE providerem wstrzykniętym przez DI. Żaden test nie dotyka
 * sieci: w każdym `globalThis.fetch` jest szpiegowany i nie może zostać wywołany (AC 14). Własny kontener,
 * żeby liczniki `llmCalls` były dokładne.
 */

const ACTIVE_MODEL = 'nightly-llm-prune-test-model';
const ENDPOINT_URL = 'http://fake.invalid/v1/chat/completions';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const LLM_ZEROS = {
  llmCalls: 0,
  llmErrors: 0,
  llmSkippedCap: 0,
  llmSkippedBreaker: 0,
  llmSkippedSecret: 0,
  llmSkippedKeyUnreadable: 0,
};
const LLM_CONFLICT_ZEROS = { llmConflictCandidates: 0, llmConflictConsistent: 0, llmConflictProposed: 0 };
const LLM_PRUNE_ZEROS = { llmPruneCandidates: 0, llmPruneKept: 0, llmPruneDeleteProposed: 0, llmPruneUpdateProposed: 0 };

function unitVector(component0: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = component0;
  v[1] = Math.sqrt(Math.max(0, 1 - component0 * component0));
  return v;
}
const NEAR = unitVector(1);

const json = (o: unknown): string => JSON.stringify(o);

/** Domyślne odpowiedzi fake'a — klucz to znacznik w nagłówku wpisu. */
function defaultRespond(user: string): string | Error {
  const h = headerOf(user);
  if (h.includes('[EPHEMERAL]')) return json({ verdict: 'delete', category: 'ephemeral', reason: 'Notatka o bieżącej pracy.' });
  if (h.includes('[EMPTY]')) return json({ verdict: 'delete', category: 'empty', reason: 'Ogólnik bez treści.' });
  if (h.includes('[VERBOSE]')) {
    return json({
      verdict: 'update',
      category: 'verbose',
      reason: 'Przegadany wpis.',
      header: 'Krótki nagłówek',
      body: 'Zwięzła treść.',
      tags: ['Alfa', 'beta'],
      kind: 'document', // próba zmiany kind — musi zostać zdjęta (G5)
    });
  }
  if (h.includes('[NOOP]')) return json({ verdict: 'update', category: 'untidy', reason: 'Bez zmian.', header: h, body: null, tags: null });
  if (h.includes('[BADBODY]')) return json({ verdict: 'update', category: 'verbose', reason: 'Zły body.', body: '' });
  if (h.includes('[BADTAG]')) return json({ verdict: 'update', category: 'untidy', reason: 'Zły tag.', tags: ['x'.repeat(41)] });
  return json({ verdict: 'keep' });
}

describe('Detektor LLM prune w nocnym jobie (integration, testcontainers) — roadmap v1.6 B2', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let audit: AuditService;
  let projectId: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function build(fake: FakeLlmProvider, envOverrides: Record<string, unknown> = {}) {
    const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused', ...envOverrides }));
    const embedding = new EmbeddingService(new StubEmbeddingProvider(ACTIVE_MODEL), config);
    const settings = new LlmSettingsService(db, config, audit);
    const llm = new LlmService(settings, fake, audit);
    const nightly = new NightlyService(db, pool, config, audit, embedding, new RecencyPruneScorer(), new UsageService(db), llm);
    const proposalsService = new ProposalsService(db, config, audit, embedding);
    return { config, settings, nightly, proposalsService };
  }

  async function enableLlm(opts: { windowDays?: number; cap?: number; apiKeyCiphertext?: string } = {}): Promise<void> {
    await db
      .update(llmSettings)
      .set({
        enabled: true,
        endpoint: ENDPOINT_URL,
        model: 'fake',
        callCap: opts.cap ?? 100,
        scanWindowDays: opts.windowDays ?? 1,
        apiKeyCiphertext: opts.apiKeyCiphertext ?? null,
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

  async function findPending(type: ProposalRow['type'], memoryId: string): Promise<ProposalRow | undefined> {
    return (await pendingNightly(type)).find((r) => r.affectedIds.length === 1 && r.affectedIds[0] === memoryId);
  }

  async function lastRunCounters(): Promise<Record<string, number>> {
    const row = await audit.latestByEventType('nightly_run');
    return (row!.metadata as { counters: Record<string, number> }).counters;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
    audit = new AuditService(db);
    projectId = (await buildProjectsService(db, config).createProject('llm-prune-test')).project.id;
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
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    // AC 14: żaden test nie sięga do sieci — wszystko idzie przez fake providera.
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // ---- AC 1: wyłączony krok = dzisiejszy przebieg -------------------------------------------

  it('AC1: krok wyłączony -> te same proposale i liczniki co przed B2 (0 promptów, 0 wywołań)', async () => {
    const a = await seedFact({ header: 'Fakt A', body: 'Treść A.' });
    const b = await seedFact({ header: 'Fakt B', body: 'Treść B dłuższa.' });
    await seedVector(a.id, NEAR);
    await seedVector(b.id, NEAR);
    const old = await seedFact({ header: 'Stary nietknięty', createdAt: daysAgo(40) });
    await seedFact({ header: '[EPHEMERAL] świeży, ale krok wyłączony' });
    const fake = new FakeLlmProvider(defaultRespond);

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
    const pending = await pendingNightly();
    expect(pending.map((p) => p.type).sort()).toEqual(['delete', 'merge']);
    expect(pending.find((p) => p.type === 'delete')!.affectedIds).toEqual([old.id]);
    expect(JSON.stringify(pending.find((p) => p.type === 'delete')!.payload)).not.toContain('rationale');
  });

  it('AC1 (wariant): włączony, ale klucz nieczytelny -> detektor nie rusza (0 wywołań, wszystkie llmPrune* i llmSkippedKeyUnreadable = 0)', async () => {
    await seedFact({ header: '[EPHEMERAL] świeży' });
    await enableLlm({ apiKeyCiphertext: createSecretBox(KEY_A).encrypt('sk-test', LLM_API_KEY_AAD) });
    const fake = new FakeLlmProvider(defaultRespond);

    const result = await build(fake, { SECRETS_ENCRYPTION_KEY: KEY_B }).nightly.run({ actor: 'tester' });

    expect(result.status).toBe('success');
    expect(result.llm?.state).toBe('key_unreadable');
    expect(result.counters).toMatchObject({ ...LLM_ZEROS, ...LLM_PRUNE_ZEROS, ...LLM_CONFLICT_ZEROS });
    expect(fake.calls).toBe(0);
  });

  // ---- AC 2: delete -------------------------------------------------------------------------

  it('AC2/AC13: efemeryczny i pusty fakt -> dwa pending delete (origin nightly) z rationale; liczniki rozróżnialne od recency', async () => {
    const eph = await seedFact({ header: '[EPHEMERAL] Teraz poprawiam testy X' });
    const empty = await seedFact({ header: '[EMPTY] Kod powinien być czytelny' });
    await enableLlm();
    const fake = new FakeLlmProvider(defaultRespond);

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(result.counters).toMatchObject({
      created: 2,
      pruneProposed: 0,
      llmPruneCandidates: 2,
      llmPruneDeleteProposed: 2,
      llmPruneUpdateProposed: 0,
      llmPruneKept: 0,
      llmCalls: 2,
    });
    const pEph = await findPending('delete', eph.id);
    const pEmpty = await findPending('delete', empty.id);
    expect(pEph).toBeDefined();
    expect(pEmpty).toBeDefined();
    expect(pEph!.origin).toBe('nightly');
    expect(pEph!.payload).toEqual({
      memoryId: eph.id,
      rationale: { detector: 'llm-prune', category: 'ephemeral', reason: 'Notatka o bieżącej pracy.' },
    });
    expect(pEmpty!.payload).toEqual({
      memoryId: empty.id,
      rationale: { detector: 'llm-prune', category: 'empty', reason: 'Ogólnik bez treści.' },
    });
    expect(pEph!.affectedIds).toEqual([eph.id]);
    expect(pEph!.baseVersions).toEqual({ [eph.id]: 0 });

    // AC13: liczniki w metadanych nightly_run, osobno od recency pruneProposed.
    const counters = await lastRunCounters();
    expect(counters.llmPruneDeleteProposed).toBe(2);
    expect(counters.pruneProposed).toBe(0);
  });

  // ---- AC 3: update + approve ---------------------------------------------------------------

  it('AC3: rozwlekły fakt -> pending update (header/body/tags, bez kind); approve podbija wersję, zapisuje rewizję i przelicza embedding', async () => {
    const fact = await seedFact({
      header: '[VERBOSE] Bardzo długi, przegadany nagłówek, który mówi to samo co treść',
      body: 'Stara, rozwlekła treść.',
      tags: ['misc', 'todo'],
    });
    await enableLlm();
    const { nightly, proposalsService } = build(new FakeLlmProvider(defaultRespond));

    const result = await nightly.run({ actor: 'tester' });
    expect(result.counters).toMatchObject({ llmPruneUpdateProposed: 1, llmPruneDeleteProposed: 0, pruneProposed: 0 });

    const proposal = await findPending('update', fact.id);
    expect(proposal).toBeDefined();
    expect(proposal!.payload).toEqual({
      memoryId: fact.id,
      header: 'Krótki nagłówek',
      body: 'Zwięzła treść.',
      tags: ['alfa', 'beta'],
      rationale: { detector: 'llm-prune', category: 'verbose', reason: 'Przegadany wpis.' },
    });
    expect(Object.keys(proposal!.payload as object)).not.toContain('kind');
    expect((await lastRunCounters()).llmPruneUpdateProposed).toBe(1);

    const approved = await proposalsService.approve(proposal!.id, { actor: 'tester' });
    expect(approved.embedding).toBe('recomputed');

    const [after] = await db.select().from(memories).where(eq(memories.id, fact.id));
    expect(after.version).toBe(1);
    expect(after.header).toBe('Krótki nagłówek');
    expect(after.body).toBe('Zwięzła treść.');
    expect(after.tags).toEqual(['alfa', 'beta']);
    expect(after.kind).toBe('fact');

    const revs = await db.select().from(revisions).where(eq(revisions.memoryId, fact.id));
    expect(revs.some((r) => r.action === 'edited' && r.snapshot !== null)).toBe(true);
    const vectors = await db
      .select()
      .from(embeddings)
      .where(and(eq(embeddings.memoryId, fact.id), eq(embeddings.embeddingModel, ACTIVE_MODEL)));
    expect(vectors.length).toBeGreaterThan(0);
  });

  // ---- AC 4: keep / no-op -------------------------------------------------------------------

  it('AC4: werdykt keep -> żadnego proposala, llmPruneKept=1', async () => {
    await seedFact({ header: 'Normalny, wartościowy fakt' });
    await enableLlm();

    const result = await build(new FakeLlmProvider(defaultRespond)).nightly.run({ actor: 'tester' });

    expect(result.counters).toMatchObject({ created: 0, llmPruneCandidates: 1, llmPruneKept: 1, llmCalls: 1, llmErrors: 0 });
    expect(await pendingNightly()).toHaveLength(0);
  });

  it('AC4: update bez realnej zmiany -> żadnego proposala, llmPruneKept=1, llmErrors=0', async () => {
    await seedFact({ header: '[NOOP] Nagłówek bez zmian', tags: ['a'] });
    await enableLlm();

    const result = await build(new FakeLlmProvider(defaultRespond)).nightly.run({ actor: 'tester' });

    expect(result.counters).toMatchObject({ created: 0, llmPruneKept: 1, llmErrors: 0 });
    expect(await pendingNightly()).toHaveLength(0);
  });

  // ---- AC 5: rationale dociera do widoku kolejki --------------------------------------------

  it('AC5 (strona serwera): ProposalsService.getProposal zwraca payload.rationale nietknięte', async () => {
    const fact = await seedFact({ header: '[EPHEMERAL] Teraz robię X' });
    await enableLlm();
    const { nightly, proposalsService } = build(new FakeLlmProvider(defaultRespond));
    await nightly.run({ actor: 'tester' });

    const proposal = await findPending('delete', fact.id);
    const view = await proposalsService.getProposal(proposal!.id);

    expect((view.payload as { rationale?: unknown }).rationale).toEqual({
      detector: 'llm-prune',
      category: 'ephemeral',
      reason: 'Notatka o bieżącej pracy.',
    });
  });

  // ---- AC 6: nieprawidłowa treść od modelu --------------------------------------------------

  it('AC6: pusty body i za długi tag od modelu -> brak proposali, llmErrors liczone (poniżej bezpiecznika)', async () => {
    await seedFact({ header: '[BADBODY] wpis jeden' });
    await seedFact({ header: '[BADTAG] wpis dwa' });
    await enableLlm();

    const result = await build(new FakeLlmProvider(defaultRespond)).nightly.run({ actor: 'tester' });

    expect(result.status).toBe('success');
    expect(result.counters).toMatchObject({ created: 0, llmErrors: 2, llmSkippedBreaker: 0, llmCalls: 2, llmPruneKept: 0 });
    expect(await pendingNightly()).toHaveLength(0);
  });

  // ---- AC 7: wykluczenia --------------------------------------------------------------------

  it('AC7: tylko świeży, zatwierdzony fakt w oknie bez pending proposala generuje wywołanie', async () => {
    await enableLlm({ windowDays: 60 });
    await seedFact({ header: 'A świeży kandydat' });
    await seedFact({ header: 'B poza oknem', createdAt: daysAgo(70), accessCount: 5, lastAccessedAt: new Date() });
    await seedFact({ header: 'C dokument', kind: 'document' });
    await seedFact({ header: 'D zdarzenie', kind: 'event', eventTime: new Date() });
    const e = await seedFact({ header: 'E para merge' });
    const f = await seedFact({ header: 'F para merge' });
    await seedVector(e.id, NEAR);
    await seedVector(f.id, NEAR);
    const g = await seedFact({ header: 'G recency', createdAt: daysAgo(40) });
    const h = await seedFact({ header: 'H pending human' });
    await insertProposal({ type: 'update', origin: 'human', affectedIds: [h.id], payload: { memoryId: h.id, body: 'x' } });
    const i = await seedFact({ header: 'I pending nightly' });
    await insertProposal({ type: 'delete', origin: 'nightly', affectedIds: [i.id] });
    await seedFact({ header: 'J zarchiwizowany', status: 'archived' });
    const fake = new FakeLlmProvider(defaultRespond);

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(result.counters.llmCalls).toBe(1);
    expect(result.counters.llmPruneCandidates).toBe(1);
    expect(fake.headers).toEqual(['A świeży kandydat']);
    // Deterministyczne propozycje nadal powstają: merge E+F i recency delete dla G.
    const merge = (await pendingNightly('merge')).find((p) => [...p.affectedIds].sort().join() === [e.id, f.id].sort().join());
    expect(merge).toBeDefined();
    expect(await findPending('delete', g.id)).toBeDefined();
  });

  // ---- AC 8: dowolny source -----------------------------------------------------------------

  it('AC8: fakty z source agent / human / nightly w oknie są oceniane', async () => {
    const facts = await Promise.all(
      (['agent', 'human', 'nightly'] as const).map((source) => seedFact({ header: `[EPHEMERAL] od ${source}`, source })),
    );
    await enableLlm();
    const fake = new FakeLlmProvider(defaultRespond);

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(fake.calls).toBe(3);
    expect(result.counters.llmPruneDeleteProposed).toBe(3);
    for (const f of facts) expect(await findPending('delete', f.id)).toBeDefined();
  });

  // ---- AC 9: okno z ustawień, na żywo -------------------------------------------------------

  it('AC9: okno czytane świeżo per przebieg — podniesienie do 7 dni działa na tej samej instancji bez restartu', async () => {
    await seedFact({ header: 'Fakt sprzed 3 dni', createdAt: daysAgo(3) });
    await enableLlm({ windowDays: 1 });
    const fake = new FakeLlmProvider(defaultRespond);
    const { nightly, settings } = build(fake);

    await nightly.run({ actor: 'tester' });
    expect(fake.calls).toBe(0);

    await settings.update(
      { enabled: true, endpoint: ENDPOINT_URL, model: 'fake', callCap: 100, timeoutMs: 30000, scanWindowDays: 7, apiKey: { action: 'keep' } },
      'tester',
    );
    const result = await nightly.run({ actor: 'tester' });

    expect(fake.calls).toBe(1);
    expect(result.counters.llmPruneCandidates).toBe(1);
  });

  // ---- AC 10: przeżycie poza oknem ----------------------------------------------------------

  it('AC10: pending proposal LLM przeżywa przebieg, w którym fakt jest poza oknem; recency i merge nadal są wycofywane', async () => {
    const x = await seedFact({ header: '[EPHEMERAL] efemeryczny' });
    const r = await seedFact({ header: 'Recency', createdAt: daysAgo(40) });
    const p1 = await seedFact({ header: 'Para 1' });
    const p2 = await seedFact({ header: 'Para 2' });
    await seedVector(p1.id, NEAR);
    await seedVector(p2.id, NEAR);
    await enableLlm();
    const { nightly } = build(new FakeLlmProvider(defaultRespond));

    const first = await nightly.run({ actor: 'tester' });
    expect(first.counters).toMatchObject({ created: 3, llmPruneDeleteProposed: 1, pruneProposed: 1, mergeProposed: 1 });
    expect(await findPending('delete', x.id)).toBeDefined();

    // X wypada z okna; warunek recency dla R ustaje; członek pary merge znika.
    await db.update(memories).set({ createdAt: daysAgo(5) }).where(eq(memories.id, x.id));
    await db.update(memories).set({ lastAccessedAt: new Date(), accessCount: 1 }).where(eq(memories.id, r.id));
    await db.update(memories).set({ status: 'archived' }).where(eq(memories.id, p1.id));

    const second = await nightly.run({ actor: 'tester' });

    expect(second.counters.withdrawn).toBe(2);
    expect(await findPending('delete', x.id)).toBeDefined(); // przeżył
    expect(await findPending('delete', r.id)).toBeUndefined();
    expect((await pendingNightly('merge')).length).toBe(0);
  });

  it('AC10 (edit): znacznik rationale przeżywa edit-before-approve — zedytowany update nadal nie jest wycofywany', async () => {
    const y = await seedFact({ header: '[VERBOSE] rozwlekły', body: 'Stara treść.' });
    await enableLlm();
    const { nightly, proposalsService } = build(new FakeLlmProvider(defaultRespond));
    await nightly.run({ actor: 'tester' });
    const proposal = await findPending('update', y.id);
    expect(proposal).toBeDefined();

    await proposalsService.edit(proposal!.id, { body: 'Ręcznie poprawiona treść.' }, { actor: 'human-dashboard' });
    const [edited] = await db.select().from(proposals).where(eq(proposals.id, proposal!.id));
    expect((edited.editedPayload as { rationale?: unknown }).rationale).toBeDefined();

    await db.update(memories).set({ createdAt: daysAgo(5) }).where(eq(memories.id, y.id));
    const second = await nightly.run({ actor: 'tester' });

    expect(second.counters.withdrawn).toBe(0);
    const [still] = await db.select().from(proposals).where(eq(proposals.id, proposal!.id));
    expect(still.status).toBe('pending');
  });

  // ---- AC 11: dwa przebiegi tego samego dnia ------------------------------------------------

  it('AC11: drugi przebieg tego samego dnia — bez duplikatów, bez wycofań, tylko wpis „keep" ponownie oceniony', async () => {
    await seedFact({ header: '[EPHEMERAL] efemeryczny' });
    await seedFact({ header: '[VERBOSE] rozwlekły' });
    await seedFact({ header: 'Normalny fakt' });
    await enableLlm();
    const fake = new FakeLlmProvider(defaultRespond);
    const { nightly } = build(fake);

    const first = await nightly.run({ actor: 'tester' });
    expect(first.counters).toMatchObject({ llmCalls: 3, created: 2, llmPruneKept: 1 });
    const pendingBefore = (await pendingNightly()).map((p) => p.id).sort();

    const second = await nightly.run({ actor: 'tester' });

    expect(second.counters).toMatchObject({ created: 0, withdrawn: 0, llmCalls: 1, llmPruneCandidates: 1 });
    expect((await pendingNightly()).map((p) => p.id).sort()).toEqual(pendingBefore);
  });

  // ---- AC 12: fail-open ---------------------------------------------------------------------

  it.each([
    ['timeout', () => new LlmTimeoutError('timeout')],
    ['sieć', () => new LlmNetworkError('connection refused')],
  ])('AC12: provider (%s) pada na każdym wywołaniu -> status success, proposale dedup/recency zapisane, bezpiecznik zadziałał', async (_label, makeError) => {
    const a = await seedFact({ header: 'Para A' });
    const b = await seedFact({ header: 'Para B' });
    await seedVector(a.id, NEAR);
    await seedVector(b.id, NEAR);
    const old = await seedFact({ header: 'Recency', createdAt: daysAgo(40) });
    for (let i = 0; i < 6; i++) await seedFact({ header: `Świeży ${i}` });
    await enableLlm();
    const fake = new FakeLlmProvider(() => makeError());

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(result.status).toBe('success');
    expect(result.counters.mergeProposed).toBe(1);
    expect(await findPending('delete', old.id)).toBeDefined();
    expect(result.counters.llmErrors).toBeGreaterThanOrEqual(3);
    expect(result.counters.llmPruneCandidates).toBe(6);
    // Przy współbieżności więcej niż 3 błędów może polecieć, zanim bezpiecznik zadziała — ale każdy kandydat
    // jest policzony albo jako błąd, albo jako pominięty przez bezpiecznik.
    expect(result.counters.llmErrors + result.counters.llmSkippedBreaker).toBe(6);
    expect(result.counters.llmPruneDeleteProposed + result.counters.llmPruneUpdateProposed).toBe(0);
  });

  it('AC12 (siatka bezpieczeństwa): wyjątek poza budżetem w detektorze -> status success, merge/recency zapisane', async () => {
    const a = await seedFact({ header: 'Para A' });
    const b = await seedFact({ header: 'Para B' });
    await seedVector(a.id, NEAR);
    await seedVector(b.id, NEAR);
    const old = await seedFact({ header: 'Recency', createdAt: daysAgo(40) });
    await enableLlm();
    const { nightly } = build(new FakeLlmProvider(defaultRespond));
    vi.spyOn(nightly as unknown as { loadPendingAffectedIds: () => Promise<Set<string>> }, 'loadPendingAffectedIds').mockRejectedValue(new Error('x'));

    const result = await nightly.run({ actor: 'tester' });

    expect(result.status).toBe('success');
    expect(result.counters).toMatchObject({ mergeProposed: 1, pruneProposed: 1, llmPruneCandidates: 0, llmCalls: 0 });
    expect(await findPending('delete', old.id)).toBeDefined();
  });

  // ---- ust. 19: politeness gate obejmuje warunki LLM ----------------------------------------

  it('ust. 19: pending proposal człowieka pojawiający się w trakcie wywołania odfiltrowuje warunek LLM (politeness)', async () => {
    const fact = await seedFact({ header: '[EPHEMERAL] efemeryczny' });
    await enableLlm();
    const fake = new FakeLlmProvider(defaultRespond);
    fake.onCall = async () => {
      await insertProposal({ type: 'update', origin: 'human', affectedIds: [fact.id], payload: { memoryId: fact.id, body: 'x' } });
    };

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect(result.counters.skippedPoliteness).toBeGreaterThanOrEqual(1);
    expect(await findPending('delete', fact.id)).toBeUndefined();
    expect(result.counters.llmPruneDeleteProposed).toBe(0);
  });

  // ---- kolejność przy capie -----------------------------------------------------------------

  it('cap=2 przy trzech kandydatach: model widzi dwa NAJSTARSZE wpisy, trzeci liczy llmSkippedCap', async () => {
    const now = Date.now();
    await seedFact({ header: 'Najnowszy', createdAt: new Date(now - 1 * HOUR_MS) });
    await seedFact({ header: 'Najstarszy', createdAt: new Date(now - 3 * HOUR_MS) });
    await seedFact({ header: 'Środkowy', createdAt: new Date(now - 2 * HOUR_MS) });
    await enableLlm({ cap: 2 });
    const fake = new FakeLlmProvider(defaultRespond);

    const result = await build(fake).nightly.run({ actor: 'tester' });

    expect([...fake.headers].sort()).toEqual(['Najstarszy', 'Środkowy']);
    expect(result.counters).toMatchObject({ llmCalls: 2, llmSkippedCap: 1, llmPruneCandidates: 3 });
  });
});
