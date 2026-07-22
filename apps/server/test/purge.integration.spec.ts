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
import { ProposalsService } from '../src/proposals/proposals.service';
import type { ProjectContext } from '../src/projects/projects.service';
import { ProjectsService } from '../src/projects/projects.service';
import { PurgeError } from '../src/purge/purge.errors';
import { PurgeService } from '../src/purge/purge.service';

/** Jak w `proposals.integration.spec.ts` — stub providera, jeden stały wektor na wszystkie chunki
 * (mechanika, nie ranking). Potrzebny wyłącznie do skonstruowania `ProposalsService` dla testu
 * "purge chroni przed nadpisaniem tombstone'a" (stale-check po version bump). */
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

interface SeedProposalInput {
  type: ProposalRow['type'];
  origin?: ProposalRow['origin'];
  payload: Record<string, unknown>;
  editedPayload?: Record<string, unknown> | null;
  status?: ProposalRow['status'];
  affectedIds?: string[];
  baseVersions?: Record<string, number>;
  scope?: ProposalRow['scope'];
  projectId?: string | null;
}

describe('PurgeService (integration, testcontainers) — hard-purge FR-S3', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let audit: AuditService;
  let purge: PurgeService;
  let projectA: ProjectContext;

  async function seedApprovedMemory(overrides: Partial<NewMemoryRow> = {}): Promise<MemoryRow> {
    const [row] = await db
      .insert(memories)
      .values({
        id: generateId(ID_PREFIX.memory),
        header: 'Seed header',
        body: 'Seed body.',
        kind: 'fact',
        tags: ['seed-tag'],
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
        status: input.status ?? 'pending',
        payload: input.payload,
        editedPayload: input.editedPayload ?? null,
        affectedIds: input.affectedIds ?? [],
        baseVersions: input.baseVersions ?? {},
        scope: input.scope ?? 'project',
        projectId: input.projectId ?? null,
      })
      .returning();
    return row;
  }

  async function seedRevision(memoryId: string, snapshot: Record<string, unknown> | null): Promise<string> {
    const id = generateId(ID_PREFIX.revision);
    await db.insert(revisions).values({
      id,
      memoryId,
      action: 'edited',
      actor: 'tester',
      snapshot,
    });
    return id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });

    projects = new ProjectsService(db);
    audit = new AuditService(db);
    purge = new PurgeService(db, audit);
    const created = await projects.createProject('purge-test');
    projectA = { projectId: created.project.id, projectName: created.project.name };
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('preview — read-only, bez mutacji', () => {
    it('liczy embeddingi/powiązane proposale/rewizje z treścią', async () => {
      const seeded = await seedApprovedMemory({ header: 'Do podgladu', projectId: projectA.projectId });
      await db.insert(embeddings).values({
        id: generateId(ID_PREFIX.embedding),
        memoryId: seeded.id,
        chunkIndex: 0,
        chunkText: 'chunk',
        embeddingModel: 'preview-model',
        vector: new Array(EMBEDDING_DIM).fill(0.01),
      });
      await seedRevision(seeded.id, { header: 'stara tresc' });
      await seedRevision(seeded.id, null); // bez tresci (np. action=created) -> nie liczy się do revisionsWithContentCount
      const relatedProposal = await seedProposal({
        type: 'update',
        payload: { memoryId: seeded.id, header: 'patch' },
        affectedIds: [seeded.id],
        baseVersions: { [seeded.id]: 0 },
        projectId: projectA.projectId,
      });

      const preview = await purge.preview(seeded.id);
      expect(preview.status).toBe('approved');
      expect(preview.header).toBe('Do podgladu');
      expect(preview.embeddingsCount).toBe(1);
      expect(preview.relatedProposalsCount).toBe(1);
      expect(preview.revisionsWithContentCount).toBe(1);

      // Read-only — nic się nie zmieniło.
      const [memRow] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(memRow.status).toBe('approved');
      expect(memRow.header).toBe('Do podgladu');
      const [propRow] = await db.select().from(proposals).where(eq(proposals.id, relatedProposal.id));
      expect((propRow.payload as { header: string }).header).toBe('patch');
    });

    it('nieistniejąca pamięć -> not_found', async () => {
      await expect(purge.preview('mem_doesnotexist0')).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('purge — happy path', () => {
    it('wymazuje treść we wszystkich content-bearing tabelach + audit purge_tombstone, zostawia niepowiązane wiersze nietknięte', async () => {
      const seeded = await seedApprovedMemory({
        header: 'Sekret w tresci',
        body: 'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP',
        tags: ['leak'],
        projectId: projectA.projectId,
      });
      await db.insert(embeddings).values([
        {
          id: generateId(ID_PREFIX.embedding),
          memoryId: seeded.id,
          chunkIndex: 0,
          chunkText: 'chunk 1',
          embeddingModel: 'purge-model',
          vector: new Array(EMBEDDING_DIM).fill(0.01),
        },
        {
          id: generateId(ID_PREFIX.embedding),
          memoryId: seeded.id,
          chunkIndex: 1,
          chunkText: 'chunk 2',
          embeddingModel: 'purge-model',
          vector: new Array(EMBEDDING_DIM).fill(0.02),
        },
      ]);
      const revWithContent = await seedRevision(seeded.id, { header: 'Sekret w tresci', body: 'AKIAABCDEFGHIJKLMNOP' });
      const revWithoutContent = await seedRevision(seeded.id, null);

      // Proposal type=create, którego jedyny link do pamięci to payload.memoryId (affectedIds=[] dla create,
      // patrz ProposalsService.materializeMemory) — pochodzi z ORYGINALNEGO save() agenta, więc niesie sekret.
      const createProposal = await seedProposal({
        type: 'create',
        status: 'approved',
        payload: { memoryId: seeded.id, header: 'Sekret w tresci', body: 'AKIAABCDEFGHIJKLMNOP', tags: ['leak'], kind: 'fact' },
        projectId: projectA.projectId,
      });

      // Pending update z edited_payload (edit-before-approve) — obie wersje (payload i editedPayload)
      // muszą zostać zredagowane niezależnie.
      const pendingUpdate = await seedProposal({
        type: 'update',
        status: 'pending',
        payload: { memoryId: seeded.id, header: 'Poprawka z sekretem', body: 'AKIAABCDEFGHIJKLMNOP' },
        editedPayload: { memoryId: seeded.id, header: 'Poprawka po review', body: 'AKIAABCDEFGHIJKLMNOP', tags: [] },
        affectedIds: [seeded.id],
        baseVersions: { [seeded.id]: 0 },
        projectId: projectA.projectId,
      });
      await db.insert(stagingEmbeddings).values({
        id: generateId(ID_PREFIX.embedding),
        proposalId: pendingUpdate.id,
        chunkIndex: 0,
        chunkText: 'staged chunk z sekretem',
        embeddingModel: 'purge-model',
        vector: new Array(EMBEDDING_DIM).fill(0.03),
      });

      // Kontrolna, NIEPOWIĄZANA pamięć + proposal — musi wyjść nietknięta.
      const unrelated = await seedApprovedMemory({ header: 'Niepowiazana', projectId: projectA.projectId });
      const unrelatedProposal = await seedProposal({
        type: 'update',
        payload: { memoryId: unrelated.id, header: 'inna tresc' },
        affectedIds: [unrelated.id],
        baseVersions: { [unrelated.id]: 0 },
        projectId: projectA.projectId,
      });

      const result = await purge.purge(seeded.id, { reason: 'AWS key wyciekł w body, rotacja wykonana', actor: 'reviewer' });

      expect(result.embeddingsDeleted).toBe(2);
      expect(result.stagingEmbeddingsDeleted).toBe(1);
      expect(result.proposalsRedacted).toBe(2); // createProposal + pendingUpdate
      expect(result.revisionsRedacted).toBe(1); // tylko revWithContent

      const [memRow] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(memRow.status).toBe('purged');
      expect(memRow.header).toBe('[purged]');
      expect(memRow.body).toBe('');
      expect(memRow.tags).toEqual([]);
      expect(memRow.version).toBe(1);

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, seeded.id));
      expect(embRows).toHaveLength(0);

      const stagedRows = await db.select().from(stagingEmbeddings).where(eq(stagingEmbeddings.proposalId, pendingUpdate.id));
      expect(stagedRows).toHaveLength(0);

      const [createAfter] = await db.select().from(proposals).where(eq(proposals.id, createProposal.id));
      const createPayload = createAfter.payload as { header: string; body: string; tags: string[]; memoryId: string; kind: string };
      expect(createPayload.header).toBe('[purged]');
      expect(createPayload.body).toBe('');
      expect(createPayload.tags).toEqual([]);
      expect(createPayload.memoryId).toBe(seeded.id); // struktura zostaje, kind/memoryId nietknięte
      expect(createPayload.kind).toBe('fact');
      expect(createAfter.status).toBe('approved'); // status proposala NIE zmieniony przez purge

      const [updateAfter] = await db.select().from(proposals).where(eq(proposals.id, pendingUpdate.id));
      const updatePayload = updateAfter.payload as { header: string; body: string };
      const updateEdited = updateAfter.editedPayload as { header: string; body: string; tags: string[] };
      expect(updatePayload.header).toBe('[purged]');
      expect(updatePayload.body).toBe('');
      expect(updateEdited.header).toBe('[purged]');
      expect(updateEdited.body).toBe('');
      expect(updateEdited.tags).toEqual([]);
      expect(updateAfter.status).toBe('pending'); // purge nie decyduje o proposalu, tylko wymazuje treść

      const [revContentAfter] = await db.select().from(revisions).where(eq(revisions.id, revWithContent));
      expect(revContentAfter.snapshot).toBeNull();
      const [revNoContentAfter] = await db.select().from(revisions).where(eq(revisions.id, revWithoutContent));
      expect(revNoContentAfter.snapshot).toBeNull(); // było już null, zostaje null

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'purge_tombstone'));
      const match = auditRows.find((a) => a.affectedIds.includes(seeded.id));
      expect(match).toBeDefined();
      expect(match!.actor).toBe('reviewer');
      expect((match!.metadata as { reason: string }).reason).toBe('AWS key wyciekł w body, rotacja wykonana');

      // Niepowiązane wiersze nietknięte.
      const [unrelatedAfter] = await db.select().from(memories).where(eq(memories.id, unrelated.id));
      expect(unrelatedAfter.status).toBe('approved');
      expect(unrelatedAfter.header).toBe('Niepowiazana');
      const [unrelatedPropAfter] = await db.select().from(proposals).where(eq(proposals.id, unrelatedProposal.id));
      expect((unrelatedPropAfter.payload as { header: string }).header).toBe('inna tresc');
    });

    it('nieistniejąca pamięć -> not_found, brak mutacji', async () => {
      await expect(purge.purge('mem_doesnotexist1', { reason: 'test', actor: 'tester' })).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('pusty --reason -> validation_error, brak mutacji', async () => {
      const seeded = await seedApprovedMemory({ header: 'Bez powodu', projectId: projectA.projectId });
      await expect(purge.purge(seeded.id, { reason: '  ', actor: 'tester' })).rejects.toMatchObject({
        code: 'validation_error',
      });
      const [memRow] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(memRow.status).toBe('approved');
      expect(memRow.header).toBe('Bez powodu');
    });

    it('podwójny purge -> already_purged, drugi raz nic nie zmienia', async () => {
      const seeded = await seedApprovedMemory({ header: 'Podwojny purge', projectId: projectA.projectId });
      await purge.purge(seeded.id, { reason: 'pierwszy', actor: 'tester' });

      await expect(purge.purge(seeded.id, { reason: 'drugi', actor: 'tester' })).rejects.toMatchObject({
        code: 'already_purged',
      });

      const [memRow] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(memRow.version).toBe(1); // drugi purge nie bumpnął wersji ponownie

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'purge_tombstone'));
      expect(auditRows.filter((a) => a.affectedIds.includes(seeded.id))).toHaveLength(1); // bez drugiego wpisu audytu
    });

    it('purge na już archived memory -> działa (nie wymaga approved)', async () => {
      const seeded = await seedApprovedMemory({ header: 'Archived przed purge', status: 'archived', projectId: projectA.projectId });
      const result = await purge.purge(seeded.id, { reason: 'PII w archived', actor: 'tester' });
      expect(result.id).toBe(seeded.id);

      const [memRow] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(memRow.status).toBe('purged');
      expect(memRow.header).toBe('[purged]');
    });
  });

  describe('interakcja z kolejką akceptacji — purge chroni przed nadpisaniem tombstone', () => {
    it('pending update proposal celujący w zpurge’owaną pamięć staje się stale przy approve (version bump, FR-Q7)', async () => {
      const provider = new StubEmbeddingProvider('purge-stale-model');
      const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
      const embeddingService = new EmbeddingService(provider, config);
      const proposalsService = new ProposalsService(db, config, audit, embeddingService);

      const seeded = await seedApprovedMemory({ header: 'Cel pending update', projectId: projectA.projectId });
      const pendingUpdate = await seedProposal({
        type: 'update',
        payload: { memoryId: seeded.id, header: 'Nowy naglowek' },
        affectedIds: [seeded.id],
        baseVersions: { [seeded.id]: 0 },
        projectId: projectA.projectId,
      });

      await purge.purge(seeded.id, { reason: 'sekret w body', actor: 'reviewer' });

      await expect(proposalsService.approve(pendingUpdate.id, { actor: 'tester' })).rejects.toMatchObject({
        code: 'stale',
        staleIds: [seeded.id],
      });

      // Tombstone nienadpisany.
      const [memRow] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(memRow.header).toBe('[purged]');
      expect(memRow.status).toBe('purged');
    });
  });
});
