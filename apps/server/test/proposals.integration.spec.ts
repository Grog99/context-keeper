import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
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
  auditLog,
  EMBEDDING_DIM,
  embeddings,
  memories,
  proposals,
  revisions,
  stagingEmbeddings,
  type MemoryRow,
  type NewMemoryRow,
  type ProposalRow,
} from '../src/db/schema';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProposalsService } from '../src/proposals/proposals.service';
import type { ProjectContext } from '../src/projects/projects.service';
import { ProjectsService } from '../src/projects/projects.service';

/** Jak w `memory.integration.spec.ts` — testcontainers nie odpala prawdziwego sidecara TEI.
 * Tutaj nie interesuje nas RANKING (żadnych testów search-ranking), więc jeden stały wektor
 * na wszystkie chunki wystarcza — testy sprawdzają MECHANIKĘ promocji/recompute, nie trafność. */
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;
  throwOnEmbed = false;
  constructor(public model: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (this.throwOnEmbed) {
      throw new Error('StubEmbeddingProvider: symulowana awaria providera');
    }
    return texts.map(() => new Array(EMBEDDING_DIM).fill(0.01));
  }

  async health(): Promise<boolean> {
    return !this.throwOnEmbed;
  }
}

interface SeedProposalInput {
  type: ProposalRow['type'];
  origin?: ProposalRow['origin'];
  payload: Record<string, unknown>;
  affectedIds?: string[];
  baseVersions?: Record<string, number>;
  scope?: ProposalRow['scope'];
  projectId?: string | null;
}

describe('ProposalsService (integration, testcontainers) — kolejka akceptacji Fazy 4', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let audit: AuditService;
  let projectA: ProjectContext;

  /** Nowa (config, embedding, memory, proposals) czwórka do testów, które potrzebują własnego
   * stuba providera (jak `buildMemoryService` w `memory.integration.spec.ts`). */
  function buildServices(
    provider: EmbeddingProvider,
    envOverrides: Record<string, unknown> = {},
  ): { config: AppConfigService; memoryService: MemoryService; proposalsService: ProposalsService } {
    const config = new AppConfigService(
      envSchema.parse({ DATABASE_URL: 'postgres://unused', ...envOverrides }),
    );
    const embeddingService = new EmbeddingService(provider, config);
    return {
      config,
      memoryService: new MemoryService(db, config, audit, embeddingService),
      proposalsService: new ProposalsService(db, config, audit, embeddingService),
    };
  }

  async function seedApprovedMemory(overrides: Partial<NewMemoryRow> = {}): Promise<MemoryRow> {
    const [row] = await db
      .insert(memories)
      .values({
        id: generateId(ID_PREFIX.memory),
        header: 'Seed header',
        body: 'Seed body.',
        kind: 'fact',
        tags: [],
        scope: 'project',
        status: 'approved',
        source: 'human',
        version: 0,
        approvedAt: new Date(),
        ...overrides,
      })
      .returning();
    return row;
  }

  async function seedProposal(input: SeedProposalInput): Promise<ProposalRow> {
    const [row] = await db
      .insert(proposals)
      .values({
        id: generateId(ID_PREFIX.proposal),
        type: input.type,
        origin: input.origin ?? 'human',
        status: 'pending',
        payload: input.payload,
        affectedIds: input.affectedIds ?? [],
        baseVersions: input.baseVersions ?? {},
        scope: input.scope ?? 'project',
        projectId: input.projectId ?? null,
      })
      .returning();
    return row;
  }

  /** Proposal typu `create` powstaje tylko przez `MemoryService.save()` — brak innego producenta
   * w v1 (patrz `memory.service.ts`). Odszukuje go po `payload.memoryId`, jak w memory.integration. */
  async function findProposalForMemory(memoryId: string, projectId: string): Promise<ProposalRow> {
    const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectId));
    const match = rows.find((p) => (p.payload as { memoryId: string }).memoryId === memoryId);
    if (!match) throw new Error(`Brak proposala dla memoryId=${memoryId}`);
    return match;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });

    projects = new ProjectsService(db);
    audit = new AuditService(db);
    const created = await projects.createProject('proposals-test');
    projectA = { projectId: created.project.id, projectName: created.project.name };
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('approve — type=create (happy path promocji embeddingu)', () => {
    it('staging promowany, memory approved v0, staging skasowany, revisions=created, audit, potem search/get znajdują', async () => {
      const provider = new StubEmbeddingProvider('create-happy-model');
      const { memoryService, proposalsService } = buildServices(provider);

      const saveRes = await memoryService.save(
        { header: 'Fakt create happy', body: 'Tresc do promocji embeddingu.' },
        projectA,
      );
      expect(saveRes.status).toBe('pending');

      const proposalRow = await findProposalForMemory(saveRes.id, projectA.projectId);
      const stagedBefore = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, proposalRow.id));
      expect(stagedBefore.length).toBeGreaterThan(0);

      const result = await proposalsService.approve(proposalRow.id, { actor: 'tester' });
      expect(result.materializedId).toBe(saveRes.id);
      expect(result.embedding).toBe('promoted');
      expect(result.archivedIds).toEqual([]);

      const [memRow] = await db.select().from(memories).where(eq(memories.id, saveRes.id));
      expect(memRow.status).toBe('approved');
      expect(memRow.version).toBe(0);

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, saveRes.id));
      expect(embRows.length).toBeGreaterThan(0);

      const stagedAfter = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, proposalRow.id));
      expect(stagedAfter.length).toBe(0);

      const revRows = await db.select().from(revisions).where(eq(revisions.memoryId, saveRes.id));
      expect(revRows.some((r) => r.action === 'created')).toBe(true);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'proposal_approved'));
      const matched = auditRows.find((a) => (a.metadata as { proposalId?: string })?.proposalId === proposalRow.id);
      expect(matched).toBeDefined();

      const found = await memoryService.search({ query: 'create happy' }, projectA);
      expect(found.some((f) => f.id === saveRes.id)).toBe(true);
      const got = await memoryService.get(saveRes.id, projectA);
      expect(got.body).toBe('Tresc do promocji embeddingu.');
    });
  });

  describe('approve — type=create, provider down przy save (fail-open, NFR-8)', () => {
    it('bez staging przy save -> approve zdrowym providerem daje recomputed', async () => {
      const downProvider = new StubEmbeddingProvider('down-at-save');
      downProvider.throwOnEmbed = true;
      const { memoryService: downMemory } = buildServices(downProvider);

      const saveRes = await downMemory.save(
        { header: 'Fakt cold path', body: 'Bez staged embeddingu przy zapisie.' },
        projectA,
      );
      const proposalRow = await findProposalForMemory(saveRes.id, projectA.projectId);
      const staged = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, proposalRow.id));
      expect(staged.length).toBe(0);

      const { proposalsService: healthyProposals } = buildServices(new StubEmbeddingProvider('healthy-at-approve'));
      const result = await healthyProposals.approve(proposalRow.id, { actor: 'tester' });
      expect(result.embedding).toBe('recomputed');

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, saveRes.id));
      expect(embRows.length).toBeGreaterThan(0);
    });

    it('provider wciąż down przy approve -> approved BEZ wektorów (vectorless), approve nie rzuca', async () => {
      const downProvider = new StubEmbeddingProvider('down-always');
      downProvider.throwOnEmbed = true;
      const { memoryService: downMemory, proposalsService: downProposals } = buildServices(downProvider);

      const saveRes = await downMemory.save(
        { header: 'Fakt zawsze down', body: 'Nigdy nie dostaje embeddingu w tym teście.' },
        projectA,
      );
      const proposalRow = await findProposalForMemory(saveRes.id, projectA.projectId);

      const result = await downProposals.approve(proposalRow.id, { actor: 'tester' });
      expect(result.embedding).toBe('vectorless');

      const [memRow] = await db.select().from(memories).where(eq(memories.id, saveRes.id));
      expect(memRow.status).toBe('approved'); // materializacja mimo braku wektora — approve nigdy nie blokuje

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, saveRes.id));
      expect(embRows.length).toBe(0);
    });
  });

  describe('approve — type=update', () => {
    it('aktualizuje pola patcha, bumpuje version, wymienia embeddingi (delete+insert), revisions=edited z prior snapshot', async () => {
      const provider = new StubEmbeddingProvider('update-model');
      const { proposalsService } = buildServices(provider);

      const seeded = await seedApprovedMemory({
        header: 'Stary naglowek',
        body: 'Stara tresc.',
        projectId: projectA.projectId,
      });
      await db.insert(embeddings).values({
        id: generateId(ID_PREFIX.embedding),
        memoryId: seeded.id,
        chunkIndex: 0,
        chunkText: 'stara tresc chunk',
        embeddingModel: 'update-model',
        vector: new Array(EMBEDDING_DIM).fill(0.02),
      });

      const proposalRow = await seedProposal({
        type: 'update',
        payload: { memoryId: seeded.id, header: 'Nowy naglowek' },
        affectedIds: [seeded.id],
        baseVersions: { [seeded.id]: 0 },
        projectId: projectA.projectId,
      });

      const result = await proposalsService.approve(proposalRow.id, { actor: 'tester' });
      expect(result.materializedId).toBe(seeded.id);

      const [memRow] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(memRow.header).toBe('Nowy naglowek');
      expect(memRow.body).toBe('Stara tresc.'); // pole spoza patcha zostaje niezmienione
      expect(memRow.version).toBe(1);

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, seeded.id));
      expect(embRows.length).toBeGreaterThan(0);
      expect(embRows.every((e) => e.chunkText !== 'stara tresc chunk')).toBe(true); // stare wiersze usunięte

      const revRows = await db.select().from(revisions).where(eq(revisions.memoryId, seeded.id));
      const editedRev = revRows.find((r) => r.action === 'edited');
      expect(editedRev).toBeDefined();
      expect((editedRev!.snapshot as { header: string }).header).toBe('Stary naglowek');
    });
  });

  describe('stale / optimistic concurrency (FR-Q7, priorytet 1 wg §15 planu)', () => {
    it('dwa update proposale na tej samej pamięci: pierwszy przechodzi, drugi -> stale, pamięć niezmieniona przez drugi', async () => {
      const { proposalsService } = buildServices(new StubEmbeddingProvider('stale-model'));
      const seeded = await seedApprovedMemory({ header: 'M', body: 'Body M.', projectId: projectA.projectId });

      const p1 = await seedProposal({
        type: 'update',
        payload: { memoryId: seeded.id, header: 'M v1' },
        affectedIds: [seeded.id],
        baseVersions: { [seeded.id]: 0 },
        projectId: projectA.projectId,
      });
      const p2 = await seedProposal({
        type: 'update',
        payload: { memoryId: seeded.id, header: 'M v2' },
        affectedIds: [seeded.id],
        baseVersions: { [seeded.id]: 0 }, // ten sam base — liczony PRZED approve #1
        projectId: projectA.projectId,
      });

      const r1 = await proposalsService.approve(p1.id, { actor: 'tester' });
      expect(r1.materializedId).toBe(seeded.id);

      await expect(proposalsService.approve(p2.id, { actor: 'tester' })).rejects.toMatchObject({
        code: 'stale',
        staleIds: [seeded.id],
      });

      const [p2After] = await db.select().from(proposals).where(eq(proposals.id, p2.id));
      expect(p2After.status).toBe('pending'); // roztrzasnięta transakcja -> zostaje pending

      const [memRow] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(memRow.header).toBe('M v1'); // approve #2 NIE dotknęło pamięci
      expect(memRow.version).toBe(1);
    });
  });

  describe('double-approve tego samego proposala', () => {
    it('drugie wywołanie approve -> already_decided', async () => {
      const { memoryService, proposalsService } = buildServices(new StubEmbeddingProvider('double-approve-model'));
      const saveRes = await memoryService.save({ header: 'Double approve', body: 'Test.' }, projectA);
      const proposalRow = await findProposalForMemory(saveRes.id, projectA.projectId);

      await proposalsService.approve(proposalRow.id, { actor: 'tester' });
      await expect(proposalsService.approve(proposalRow.id, { actor: 'tester' })).rejects.toMatchObject({
        code: 'already_decided',
      });
    });
  });

  describe('approve — type=merge', () => {
    it('tworzy C, archiwizuje A i B (+version bump, embeddingi usunięte), revisions linkują C<->A,B', async () => {
      const { proposalsService } = buildServices(new StubEmbeddingProvider('merge-model'));

      const a = await seedApprovedMemory({ header: 'A', body: 'Tresc A.', projectId: projectA.projectId });
      const b = await seedApprovedMemory({ header: 'B', body: 'Tresc B.', projectId: projectA.projectId });
      await db.insert(embeddings).values([
        {
          id: generateId(ID_PREFIX.embedding),
          memoryId: a.id,
          chunkIndex: 0,
          chunkText: 'a chunk',
          embeddingModel: 'merge-model',
          vector: new Array(EMBEDDING_DIM).fill(0.01),
        },
        {
          id: generateId(ID_PREFIX.embedding),
          memoryId: b.id,
          chunkIndex: 0,
          chunkText: 'b chunk',
          embeddingModel: 'merge-model',
          vector: new Array(EMBEDDING_DIM).fill(0.02),
        },
      ]);

      const cId = generateId(ID_PREFIX.memory);
      const proposalRow = await seedProposal({
        type: 'merge',
        payload: { memoryId: cId, header: 'C scalony', body: 'Tresc scalona A+B.', tags: [], kind: 'fact' },
        affectedIds: [a.id, b.id],
        baseVersions: { [a.id]: 0, [b.id]: 0 },
        projectId: projectA.projectId,
      });

      const result = await proposalsService.approve(proposalRow.id, { actor: 'tester' });
      expect(result.materializedId).toBe(cId);
      expect([...result.archivedIds].sort()).toEqual([a.id, b.id].sort());

      const [cRow] = await db.select().from(memories).where(eq(memories.id, cId));
      expect(cRow.status).toBe('approved');
      expect(cRow.version).toBe(0);

      const [aAfter] = await db.select().from(memories).where(eq(memories.id, a.id));
      const [bAfter] = await db.select().from(memories).where(eq(memories.id, b.id));
      expect(aAfter.status).toBe('archived');
      expect(aAfter.version).toBe(1);
      expect(bAfter.status).toBe('archived');
      expect(bAfter.version).toBe(1);

      const aEmb = await db.select().from(embeddings).where(eq(embeddings.memoryId, a.id));
      const bEmb = await db.select().from(embeddings).where(eq(embeddings.memoryId, b.id));
      expect(aEmb.length).toBe(0);
      expect(bEmb.length).toBe(0);

      const cRevs = await db.select().from(revisions).where(eq(revisions.memoryId, cId));
      expect(cRevs.some((r) => r.action === 'created')).toBe(true);

      const aRevs = await db.select().from(revisions).where(eq(revisions.memoryId, a.id));
      const bRevs = await db.select().from(revisions).where(eq(revisions.memoryId, b.id));
      expect(aRevs.some((r) => r.action === 'superseded_by' && r.supersededBy === cId)).toBe(true);
      expect(bRevs.some((r) => r.action === 'superseded_by' && r.supersededBy === cId)).toBe(true);
    });

    it('partial-stale: jedna z affected zmieniona poza transakcją -> cały approve pada atomowo (A nie archiwizowane, C nie powstaje)', async () => {
      const { proposalsService } = buildServices(new StubEmbeddingProvider('merge-partial-stale-model'));

      const a = await seedApprovedMemory({ header: 'A2', body: 'Tresc A2.', projectId: projectA.projectId });
      const b = await seedApprovedMemory({ header: 'B2', body: 'Tresc B2.', projectId: projectA.projectId });

      const cId = generateId(ID_PREFIX.memory);
      const proposalRow = await seedProposal({
        type: 'merge',
        payload: { memoryId: cId, header: 'C2', body: 'Tresc scalona.', tags: [], kind: 'fact' },
        affectedIds: [a.id, b.id],
        baseVersions: { [a.id]: 0, [b.id]: 0 },
        projectId: projectA.projectId,
      });

      // Symuluje inną zatwierdzoną zmianę B międzyczasie (poza tą transakcją).
      await db.update(memories).set({ version: 1 }).where(eq(memories.id, b.id));

      await expect(proposalsService.approve(proposalRow.id, { actor: 'tester' })).rejects.toMatchObject({
        code: 'stale',
        staleIds: [b.id],
      });

      const [aAfter] = await db.select().from(memories).where(eq(memories.id, a.id));
      expect(aAfter.status).toBe('approved'); // NIE zarchiwizowane — pełny rollback, nie częściowy
      const cRows = await db.select().from(memories).where(eq(memories.id, cId));
      expect(cRows.length).toBe(0); // C nie powstało
    });
  });

  describe('approve — type=delete', () => {
    it('archiwizuje + bump version + usuwa embeddingi + revisions action=archive', async () => {
      const { proposalsService } = buildServices(new StubEmbeddingProvider('delete-model'));
      const seeded = await seedApprovedMemory({
        header: 'Do usuniecia',
        body: 'Tresc do skasowania.',
        projectId: projectA.projectId,
      });
      await db.insert(embeddings).values({
        id: generateId(ID_PREFIX.embedding),
        memoryId: seeded.id,
        chunkIndex: 0,
        chunkText: 'chunk do usuniecia',
        embeddingModel: 'delete-model',
        vector: new Array(EMBEDDING_DIM).fill(0.03),
      });

      const proposalRow = await seedProposal({
        type: 'delete',
        payload: { memoryId: seeded.id },
        affectedIds: [seeded.id],
        baseVersions: { [seeded.id]: 0 },
        projectId: projectA.projectId,
      });

      const result = await proposalsService.approve(proposalRow.id, { actor: 'tester' });
      expect(result.archivedIds).toEqual([seeded.id]);
      expect(result.materializedId).toBeUndefined();
      expect(result.embedding).toBe('vectorless'); // delete nie materializuje treści — brak dyspozycji embeddingu

      const [memRow] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(memRow.status).toBe('archived');
      expect(memRow.version).toBe(1);

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, seeded.id));
      expect(embRows.length).toBe(0);

      const revRows = await db.select().from(revisions).where(eq(revisions.memoryId, seeded.id));
      expect(revRows.some((r) => r.action === 'archive')).toBe(true);
    });
  });

  describe('reject', () => {
    it('status=rejected, staging usunięty, audit proposal_rejected, memory store nietknięty (memory nigdy nie powstało)', async () => {
      const { memoryService, proposalsService } = buildServices(new StubEmbeddingProvider('reject-model'));
      const saveRes = await memoryService.save({ header: 'Do odrzucenia', body: 'Tresc.' }, projectA);
      const proposalRow = await findProposalForMemory(saveRes.id, projectA.projectId);
      const stagedBefore = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, proposalRow.id));
      expect(stagedBefore.length).toBeGreaterThan(0);

      await proposalsService.reject(proposalRow.id, { actor: 'tester', reason: 'niepotrzebne' });

      const [propAfter] = await db.select().from(proposals).where(eq(proposals.id, proposalRow.id));
      expect(propAfter.status).toBe('rejected');

      const stagedAfter = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, proposalRow.id));
      expect(stagedAfter.length).toBe(0);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'proposal_rejected'));
      expect(
        auditRows.some((a) => (a.metadata as { proposalId?: string })?.proposalId === proposalRow.id),
      ).toBe(true);

      const memRows = await db.select().from(memories).where(eq(memories.id, saveRes.id));
      expect(memRows.length).toBe(0);
    });

    it('reject po już zdecydowanym proposalu -> already_decided', async () => {
      const { memoryService, proposalsService } = buildServices(new StubEmbeddingProvider('reject-twice-model'));
      const saveRes = await memoryService.save({ header: 'Reject dwukrotny', body: 'Tresc.' }, projectA);
      const proposalRow = await findProposalForMemory(saveRes.id, projectA.projectId);

      await proposalsService.reject(proposalRow.id, { actor: 'tester' });
      await expect(proposalsService.reject(proposalRow.id, { actor: 'tester' })).rejects.toMatchObject({
        code: 'already_decided',
      });
    });
  });

  describe('edit-before-approve (FR-Q6)', () => {
    it('edit() ustawia edited_payload i kasuje staging; approve() materializuje edytowaną treść z recompute embeddingu; payload trzyma oryginał', async () => {
      const { memoryService } = buildServices(new StubEmbeddingProvider('edit-save-model'));
      const saveRes = await memoryService.save(
        { header: 'Oryginalny naglowek', body: 'Oryginalna tresc.' },
        projectA,
      );
      const proposalRow = await findProposalForMemory(saveRes.id, projectA.projectId);
      const stagedBefore = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, proposalRow.id));
      expect(stagedBefore.length).toBeGreaterThan(0);

      const { proposalsService } = buildServices(new StubEmbeddingProvider('edit-approve-model'));

      const editResult = await proposalsService.edit(
        proposalRow.id,
        { header: 'Edytowany naglowek' },
        { actor: 'reviewer' },
      );
      expect(editResult.warnings).toEqual([]);

      const [propAfterEdit] = await db.select().from(proposals).where(eq(proposals.id, proposalRow.id));
      expect((propAfterEdit.editedPayload as { header: string }).header).toBe('Edytowany naglowek');
      expect((propAfterEdit.payload as { header: string }).header).toBe('Oryginalny naglowek'); // oryginał nietknięty
      expect(propAfterEdit.status).toBe('pending'); // edit NIE zmienia statusu

      const stagedAfterEdit = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, proposalRow.id));
      expect(stagedAfterEdit.length).toBe(0);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'proposal_edited'));
      expect(
        auditRows.some((a) => (a.metadata as { proposalId?: string })?.proposalId === proposalRow.id),
      ).toBe(true);

      const approveResult = await proposalsService.approve(proposalRow.id, { actor: 'reviewer' });
      expect(approveResult.embedding).toBe('recomputed'); // staging usunięty przez edit -> cold path

      const [memRow] = await db.select().from(memories).where(eq(memories.id, saveRes.id));
      expect(memRow.header).toBe('Edytowany naglowek');
    });

    it('sekret w edytowanej treści -> ostrzeżenie non-blocking, treść i tak zapisana (FR-S1: human=warn, nie block)', async () => {
      const { memoryService, proposalsService } = buildServices(new StubEmbeddingProvider('edit-warn-model'));
      const saveRes = await memoryService.save({ header: 'Do edycji z sekretem', body: 'Czysta tresc.' }, projectA);
      const proposalRow = await findProposalForMemory(saveRes.id, projectA.projectId);

      const result = await proposalsService.edit(
        proposalRow.id,
        { body: 'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP' },
        { actor: 'reviewer' },
      );
      expect(result.warnings.length).toBeGreaterThan(0);

      const [propAfter] = await db.select().from(proposals).where(eq(proposals.id, proposalRow.id));
      expect((propAfter.editedPayload as { body: string }).body).toContain('AKIAABCDEFGHIJKLMNOP');
    });
  });

  describe('supersession (FR-Q8)', () => {
    it('approve(id, {supersedes:X}) -> N utworzone, X zarchiwizowane, revisions linkują (N.supersedes=X, X.supersededBy=N), audit affectedIds=[N,X]', async () => {
      const { memoryService, proposalsService } = buildServices(new StubEmbeddingProvider('supersede-model'));

      const x = await seedApprovedMemory({
        header: 'X do zastapienia',
        body: 'Stara wersja faktu.',
        projectId: projectA.projectId,
      });

      const saveRes = await memoryService.save({ header: 'N zastepujacy X', body: 'Nowa wersja faktu.' }, projectA);
      const proposalRow = await findProposalForMemory(saveRes.id, projectA.projectId);

      const result = await proposalsService.approve(proposalRow.id, {
        actor: 'reviewer',
        supersedes: x.id,
      });
      expect(result.materializedId).toBe(saveRes.id);
      expect(result.archivedIds).toEqual([x.id]);

      const [xAfter] = await db.select().from(memories).where(eq(memories.id, x.id));
      expect(xAfter.status).toBe('archived');
      expect(xAfter.version).toBe(1);

      const nRevs = await db.select().from(revisions).where(eq(revisions.memoryId, saveRes.id));
      expect(nRevs.some((r) => r.action === 'created' && r.supersedes === x.id)).toBe(true);

      const xRevs = await db.select().from(revisions).where(eq(revisions.memoryId, x.id));
      expect(xRevs.some((r) => r.action === 'superseded_by' && r.supersededBy === saveRes.id)).toBe(true);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'proposal_approved'));
      const match = auditRows.find((a) => (a.metadata as { proposalId?: string })?.proposalId === proposalRow.id);
      expect(match).toBeDefined();
      expect([...match!.affectedIds].sort()).toEqual([saveRes.id, x.id].sort());
    });

    it('--supersedes na proposalu innym niż create -> validation_error', async () => {
      const { proposalsService } = buildServices(new StubEmbeddingProvider('supersede-wrong-type-model'));
      const seeded = await seedApprovedMemory({ header: 'M', body: 'Body.', projectId: projectA.projectId });
      const other = await seedApprovedMemory({ header: 'X', body: 'Body X.', projectId: projectA.projectId });

      const proposalRow = await seedProposal({
        type: 'update',
        payload: { memoryId: seeded.id, header: 'M zmienione' },
        affectedIds: [seeded.id],
        baseVersions: { [seeded.id]: 0 },
        projectId: projectA.projectId,
      });

      await expect(
        proposalsService.approve(proposalRow.id, { actor: 'tester', supersedes: other.id }),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
  });

  describe('listPending / getProposal — stale display-only (bez locka)', () => {
    it('listPending oznacza proposal jako stale gdy affected memory zmieniła wersję poza jego base_versions', async () => {
      const { proposalsService } = buildServices(new StubEmbeddingProvider('list-stale-model'));
      const seeded = await seedApprovedMemory({ header: 'Lista M', body: 'Body.', projectId: projectA.projectId });

      const proposalRow = await seedProposal({
        type: 'update',
        payload: { memoryId: seeded.id, header: 'Nowy' },
        affectedIds: [seeded.id],
        baseVersions: { [seeded.id]: 0 },
        projectId: projectA.projectId,
      });

      const beforeBump = await proposalsService.getProposal(proposalRow.id);
      expect(beforeBump.stale).toBe(false);

      await db.update(memories).set({ version: 1 }).where(eq(memories.id, seeded.id));

      const afterBump = await proposalsService.getProposal(proposalRow.id);
      expect(afterBump.stale).toBe(true);
      expect(afterBump.staleIds).toEqual([seeded.id]);

      const list = await proposalsService.listPending({ projectId: projectA.projectId });
      const found = list.find((p) => p.id === proposalRow.id);
      expect(found?.stale).toBe(true);
    });

    it('getProposal dla nieistniejącego id -> not_found', async () => {
      const { proposalsService } = buildServices(new StubEmbeddingProvider('not-found-model'));
      await expect(proposalsService.getProposal('prop_doesnotexist0')).rejects.toMatchObject({
        code: 'not_found',
      });
    });
  });
});
