import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  revisions,
  type MemoryRow,
  type NewMemoryRow,
} from '../src/db/schema';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { MemoryAdminService } from '../src/memory/memory-admin.service';
import type { ProjectContext } from '../src/projects/projects.service';
import { ProjectsService } from '../src/projects/projects.service';

/** Jak w `proposals.integration.spec.ts` — wektor stały, testy tutaj sprawdzają MECHANIKĘ
 * (revisions/audit/embeddings/scope), nie trafność rankingu. */
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

describe('MemoryAdminService (integration, testcontainers) — przeglądarka pamięci + human-create/edit/archive/promote (Fazy 5 M1)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let audit: AuditService;
  let projectA: ProjectContext;
  let projectB: ProjectContext;

  function buildAdmin(
    provider: EmbeddingProvider,
    envOverrides: Record<string, unknown> = {},
  ): { config: AppConfigService; admin: MemoryAdminService } {
    const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused', ...envOverrides }));
    const embeddingService = new EmbeddingService(provider, config);
    return { config, admin: new MemoryAdminService(db, config, audit, embeddingService) };
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

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });

    projects = new ProjectsService(db, new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' })));
    audit = new AuditService(db);
    const createdA = await projects.createProject('memory-admin-test-a');
    projectA = { projectId: createdA.project.id, projectName: createdA.project.name };
    const createdB = await projects.createProject('memory-admin-test-b');
    projectB = { projectId: createdB.project.id, projectName: createdB.project.name };
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('humanCreate', () => {
    it('wstawia approved memory source=human, revisions=created, audit human_edit, embedding fail-open (up -> recomputed)', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('human-create-model'));

      const result = await admin.humanCreate({
        kind: 'fact',
        header: 'Human-created fakt',
        body: 'Tresc utworzona recznie.',
        tags: ['human'],
        scope: 'project',
        projectId: projectA.projectId,
      });
      expect(result.warnings).toEqual([]);
      expect(result.id).toMatch(/^mem_/);

      const [row] = await db.select().from(memories).where(eq(memories.id, result.id));
      expect(row.status).toBe('approved');
      expect(row.source).toBe('human');
      expect(row.version).toBe(0);
      expect(row.scope).toBe('project');
      expect(row.projectId).toBe(projectA.projectId);

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, result.id));
      expect(embRows.length).toBeGreaterThan(0);

      const revRows = await db.select().from(revisions).where(eq(revisions.memoryId, result.id));
      expect(revRows.some((r) => r.action === 'created' && r.actor === 'human-dashboard')).toBe(true);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'human_edit'));
      expect(auditRows.some((a) => a.affectedIds.includes(result.id))).toBe(true);
    });

    it('embedding provider down -> memory i tak approved (fail-open, vectorless)', async () => {
      const provider = new StubEmbeddingProvider('human-create-down-model');
      provider.throwOnEmbed = true;
      const { admin } = buildAdmin(provider);

      const result = await admin.humanCreate({
        kind: 'fact',
        header: 'Human-created bez embeddingu',
        body: 'Provider padl przy tworzeniu.',
        scope: 'global',
      });

      const [row] = await db.select().from(memories).where(eq(memories.id, result.id));
      expect(row.status).toBe('approved');
      expect(row.scope).toBe('global');
      expect(row.projectId).toBeNull();

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, result.id));
      expect(embRows.length).toBe(0);
    });

    it('sekret w treści -> ostrzeżenie non-blocking, memory i tak zapisana (FR-S1: human=warn)', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('human-create-secret-model'));

      const result = await admin.humanCreate({
        kind: 'fact',
        header: 'Fakt z sekretem',
        body: 'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP',
        scope: 'project',
        projectId: projectA.projectId,
      });
      expect(result.warnings.length).toBeGreaterThan(0);

      const [row] = await db.select().from(memories).where(eq(memories.id, result.id));
      expect(row.status).toBe('approved');
      expect(row.body).toContain('AKIAABCDEFGHIJKLMNOP');
    });

    it('scope=project bez projectId -> validation_error (ToolError)', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('human-create-invalid-model'));
      await expect(
        admin.humanCreate({ kind: 'fact', header: 'X', body: 'Y', scope: 'project' }),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    describe('kind=event (roadmap v1.2, "kind=event episodic")', () => {
      it('zapisuje event_time, kind=event w wierszu', async () => {
        const { admin } = buildAdmin(new StubEmbeddingProvider('human-create-event-model'));
        const eventTime = '2026-01-15T10:30:00Z';

        const result = await admin.humanCreate({
          kind: 'event',
          header: 'Zdarzenie human-create',
          body: 'Cos sie wydarzylo.',
          scope: 'project',
          projectId: projectA.projectId,
          eventTime,
        });

        const [row] = await db.select().from(memories).where(eq(memories.id, result.id));
        expect(row.kind).toBe('event');
        expect(row.eventTime?.toISOString()).toBe('2026-01-15T10:30:00.000Z');
        expect(row.status).toBe('approved');
      });

      it('brak eventTime dla kind=event -> validation_error, NIC nie jest zapisane', async () => {
        const { admin } = buildAdmin(new StubEmbeddingProvider('human-create-event-missing-model'));
        await expect(
          admin.humanCreate({
            kind: 'event',
            header: 'Zdarzenie bez czasu',
            body: 'Brak event_time.',
            scope: 'project',
            projectId: projectA.projectId,
          }),
        ).rejects.toMatchObject({ code: 'validation_error' });
      });

      it('eventTime ignorowany (pozostaje null) dla kind=fact', async () => {
        const { admin } = buildAdmin(new StubEmbeddingProvider('human-create-event-ignored-model'));
        const result = await admin.humanCreate({
          kind: 'fact',
          header: 'Fakt z ignorowanym eventTime',
          body: 'To jest fakt, nie event.',
          scope: 'project',
          projectId: projectA.projectId,
          eventTime: '2026-01-15T10:30:00Z',
        });

        const [row] = await db.select().from(memories).where(eq(memories.id, result.id));
        expect(row.eventTime).toBeNull();
      });
    });
  });

  describe('listEvents — ekran "Oś czasu" (roadmap v1.2, "kind=event episodic")', () => {
    async function seedEvent(overrides: Partial<NewMemoryRow> & { eventTime: Date }): Promise<MemoryRow> {
      const [row] = await db
        .insert(memories)
        .values({
          id: generateId(ID_PREFIX.memory),
          header: 'Seed event header',
          body: 'Seed event body.',
          kind: 'event',
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

    it('zwraca WYŁĄCZNIE kind=event, posortowane event_time DESC', async () => {
      const marker = `listevents-order-${generateId('m')}`;
      const older = await seedEvent({
        header: `${marker} starszy`,
        projectId: projectA.projectId,
        eventTime: new Date('2026-01-01T00:00:00Z'),
      });
      const newer = await seedEvent({
        header: `${marker} nowszy`,
        projectId: projectA.projectId,
        eventTime: new Date('2026-01-10T00:00:00Z'),
      });
      const nonEvent = await seedApprovedMemory({
        header: `${marker} fakt`,
        body: 'To jest fakt, nie event.',
        projectId: projectA.projectId,
      });

      const { admin } = buildAdmin(new StubEmbeddingProvider('list-events-order-model'));
      const results = await admin.listEvents({ scope: 'project', projectId: projectA.projectId });
      const ids = results.map((r) => r.id);
      expect(ids).not.toContain(nonEvent.id); // strict kind=event, żaden fact się nie wkrada
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
      for (const r of results) expect(r.kind).toBe('event');
    });

    it('scope=project jest STRICT — brak przecieku eventów innego projektu ani global', async () => {
      const marker = `listevents-scope-${generateId('m')}`;
      const inA = await seedEvent({
        header: `${marker} w A`,
        projectId: projectA.projectId,
        eventTime: new Date(),
      });
      const inB = await seedEvent({
        header: `${marker} w B`,
        projectId: projectB.projectId,
        eventTime: new Date(),
      });
      const global = await seedEvent({
        header: `${marker} global`,
        scope: 'global',
        projectId: null,
        eventTime: new Date(),
      });

      const { admin } = buildAdmin(new StubEmbeddingProvider('list-events-scope-model'));
      const results = await admin.listEvents({ scope: 'project', projectId: projectA.projectId });
      const ids = results.map((r) => r.id);
      expect(ids).toContain(inA.id);
      expect(ids).not.toContain(inB.id);
      expect(ids).not.toContain(global.id);
    });
  });

  describe('editMemory', () => {
    it('bumpuje version, wymienia embeddingi (delete+insert), revisions=edited z prior snapshot, audit human_edit', async () => {
      const seeded = await seedApprovedMemory({
        header: 'Stary naglowek edit',
        body: 'Stara tresc edit.',
        projectId: projectA.projectId,
      });
      await db.insert(embeddings).values({
        id: generateId(ID_PREFIX.embedding),
        memoryId: seeded.id,
        chunkIndex: 0,
        chunkText: 'stara tresc chunk edit',
        embeddingModel: 'edit-model',
        vector: new Array(EMBEDDING_DIM).fill(0.02),
      });

      const { admin } = buildAdmin(new StubEmbeddingProvider('edit-model'));
      const result = await admin.editMemory(seeded.id, { header: 'Nowy naglowek edit' });
      expect(result.warnings).toEqual([]);

      const [row] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(row.header).toBe('Nowy naglowek edit');
      expect(row.body).toBe('Stara tresc edit.'); // pole spoza edita zostaje niezmienione
      expect(row.version).toBe(1);

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, seeded.id));
      expect(embRows.length).toBeGreaterThan(0);
      expect(embRows.every((e) => e.chunkText !== 'stara tresc chunk edit')).toBe(true);

      const revRows = await db.select().from(revisions).where(eq(revisions.memoryId, seeded.id));
      const editedRev = revRows.find((r) => r.action === 'edited');
      expect(editedRev).toBeDefined();
      expect((editedRev!.snapshot as { header: string }).header).toBe('Stary naglowek edit');

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'human_edit'));
      expect(auditRows.some((a) => a.affectedIds.includes(seeded.id))).toBe(true);
    });

    it('edit nieistniejącej pamięci -> not_found', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('edit-missing-model'));
      await expect(admin.editMemory('mem_doesnotexist0', { header: 'X' })).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    describe('eventTime (roadmap v1.2, "Edycja event_time po utworzeniu")', () => {
      it('edycja event_time na kind=event aktualizuje row.eventTime, bumpuje version, snapshot rewizji ma STARĄ wartość', async () => {
        const oldEventTime = new Date('2026-01-01T00:00:00Z');
        const seeded = await seedApprovedMemory({
          kind: 'event',
          header: 'Zdarzenie do korekty czasu',
          body: 'Tresc zdarzenia.',
          projectId: projectA.projectId,
          eventTime: oldEventTime,
        });

        const { admin } = buildAdmin(new StubEmbeddingProvider('edit-event-time-model'));
        const newEventTime = '2026-02-15T12:00:00Z';
        const result = await admin.editMemory(seeded.id, { eventTime: newEventTime });
        expect(result.warnings).toEqual([]);

        const [row] = await db.select().from(memories).where(eq(memories.id, seeded.id));
        expect(row.eventTime?.toISOString()).toBe('2026-02-15T12:00:00.000Z');
        expect(row.version).toBe(1);

        const revRows = await db.select().from(revisions).where(eq(revisions.memoryId, seeded.id));
        const editedRev = revRows.find((r) => r.action === 'edited');
        expect(editedRev).toBeDefined();
        expect((editedRev!.snapshot as { eventTime: string }).eventTime).toBe(oldEventTime.toISOString());
      });

      it('editMemory({ eventTime }) na kind=fact -> validation_error', async () => {
        const seeded = await seedApprovedMemory({
          header: 'Fakt bez event_time',
          body: 'To jest fakt.',
          projectId: projectA.projectId,
        });
        const { admin } = buildAdmin(new StubEmbeddingProvider('edit-event-time-fact-model'));
        await expect(
          admin.editMemory(seeded.id, { eventTime: '2026-02-15T12:00:00Z' }),
        ).rejects.toMatchObject({ code: 'validation_error' });
      });

      it('editMemory({ header }) na kind=event BEZ eventTime -> sukces, event_time niezmieniony (fallback)', async () => {
        const originalEventTime = new Date('2026-03-01T09:00:00Z');
        const seeded = await seedApprovedMemory({
          kind: 'event',
          header: 'Zdarzenie edytowane bez zmiany czasu',
          body: 'Tresc zdarzenia.',
          projectId: projectA.projectId,
          eventTime: originalEventTime,
        });

        const { admin } = buildAdmin(new StubEmbeddingProvider('edit-event-time-fallback-model'));
        const result = await admin.editMemory(seeded.id, { header: 'Nowy naglowek bez zmiany czasu' });
        expect(result.warnings).toEqual([]);

        const [row] = await db.select().from(memories).where(eq(memories.id, seeded.id));
        expect(row.header).toBe('Nowy naglowek bez zmiany czasu');
        expect(row.eventTime?.toISOString()).toBe(originalEventTime.toISOString());
      });
    });
  });

  describe('archiveMemory', () => {
    it('soft-delete: status=archived, version+1, embeddingi usunięte, revisions=archive, audit archive', async () => {
      const seeded = await seedApprovedMemory({ header: 'Do archiwizacji', body: 'Tresc.', projectId: projectA.projectId });
      await db.insert(embeddings).values({
        id: generateId(ID_PREFIX.embedding),
        memoryId: seeded.id,
        chunkIndex: 0,
        chunkText: 'chunk do archiwizacji',
        embeddingModel: 'archive-model',
        vector: new Array(EMBEDDING_DIM).fill(0.03),
      });
      const { admin } = buildAdmin(new StubEmbeddingProvider('archive-model'));

      await admin.archiveMemory(seeded.id);

      const [row] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(row.status).toBe('archived');
      expect(row.version).toBe(1);

      const embRows = await db.select().from(embeddings).where(eq(embeddings.memoryId, seeded.id));
      expect(embRows.length).toBe(0);

      const revRows = await db.select().from(revisions).where(eq(revisions.memoryId, seeded.id));
      expect(revRows.some((r) => r.action === 'archive')).toBe(true);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'archive'));
      expect(auditRows.some((a) => a.affectedIds.includes(seeded.id))).toBe(true);
    });

    it('archiwizacja już zarchiwizowanej -> validation_error', async () => {
      const seeded = await seedApprovedMemory({ header: 'Podwojna archiwizacja', body: 'T.', projectId: projectA.projectId });
      const { admin } = buildAdmin(new StubEmbeddingProvider('archive-twice-model'));
      await admin.archiveMemory(seeded.id);
      await expect(admin.archiveMemory(seeded.id)).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('archiwizacja usuwa krawędzie grafu dotykające pamięci — WYCHODZĄCE i PRZYCHODZĄCE — i audytuje relation_removed dla obu (roadmap v1.2, mirror embeddingów)', async () => {
      const seeded = await seedApprovedMemory({
        header: 'Do archiwizacji z relacjami',
        body: 'Tresc.',
        projectId: projectA.projectId,
      });
      const outNeighbor = await seedApprovedMemory({
        header: 'Sasiad wychodzacy archive',
        body: 'T.',
        projectId: projectA.projectId,
      });
      const inNeighbor = await seedApprovedMemory({
        header: 'Sasiad przychodzacy archive',
        body: 'T.',
        projectId: projectA.projectId,
      });
      const { admin } = buildAdmin(new StubEmbeddingProvider('archive-relations-model'));

      const outRelation = await admin.createRelation({ fromId: seeded.id, toId: outNeighbor.id, type: 'follows' });
      const inRelation = await admin.createRelation({ fromId: inNeighbor.id, toId: seeded.id, type: 'caused_by' });

      await admin.archiveMemory(seeded.id);

      const rows = await db
        .select()
        .from(memoryRelations)
        .where(or(eq(memoryRelations.fromMemoryId, seeded.id), eq(memoryRelations.toMemoryId, seeded.id)));
      expect(rows).toHaveLength(0);

      // Kaskada z archiveMemory audytuje KAŻDĄ usuniętą krawędź jako relation_removed, via='archive'
      // — odróżnione od ręcznego `removeRelation` (via='human', patrz test niżej).
      const removedAudit = await db.select().from(auditLog).where(eq(auditLog.eventType, 'relation_removed'));
      const removedOut = removedAudit.find(
        (r) => (r.metadata as { relationId?: string }).relationId === outRelation.id,
      );
      expect(removedOut).toBeDefined();
      expect([...removedOut!.affectedIds].sort()).toEqual([seeded.id, outNeighbor.id].sort());
      expect((removedOut!.metadata as { via?: string }).via).toBe('archive');
      const removedIn = removedAudit.find(
        (r) => (r.metadata as { relationId?: string }).relationId === inRelation.id,
      );
      expect(removedIn).toBeDefined();
      expect([...removedIn!.affectedIds].sort()).toEqual([seeded.id, inNeighbor.id].sort());
      expect((removedIn!.metadata as { via?: string }).via).toBe('archive');

      // Krawędź MIĘDZY DWOMA sąsiadami (nietknięta pamięć) musi przetrwać — archiwizacja usuwa
      // wyłącznie krawędzie DOTYKAJĄCE archiwizowanej pamięci, nie cały graf projektu.
      await admin.createRelation({ fromId: outNeighbor.id, toId: inNeighbor.id, type: 'context_for' });
      const untouched = await db
        .select()
        .from(memoryRelations)
        .where(eq(memoryRelations.fromMemoryId, outNeighbor.id));
      expect(untouched).toHaveLength(1);
    });
  });

  describe('relations — zakładka "Relacje" (roadmap v1.2, "memory-relations + 1-hop graph boost")', () => {
    it('createRelation happy path: insert source=human, audit relation_created via=human', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('relation-happy-model'));
      const from = await seedApprovedMemory({ header: 'Relacja from', body: 'T.', projectId: projectA.projectId });
      const to = await seedApprovedMemory({ header: 'Relacja to', body: 'T.', projectId: projectA.projectId });

      const result = await admin.createRelation({ fromId: from.id, toId: to.id, type: 'follows' });
      expect(result.id).toMatch(/^rel_/);

      const [row] = await db.select().from(memoryRelations).where(eq(memoryRelations.id, result.id));
      expect(row.fromMemoryId).toBe(from.id);
      expect(row.toMemoryId).toBe(to.id);
      expect(row.type).toBe('follows');
      expect(row.source).toBe('human');
      expect(row.projectId).toBe(projectA.projectId);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'relation_created'));
      const match = auditRows.find((a) => (a.metadata as { relationId?: string })?.relationId === result.id);
      expect(match).toBeDefined();
      expect([...match!.affectedIds].sort()).toEqual([from.id, to.id].sort());
      expect((match!.metadata as { via?: string }).via).toBe('human');
    });

    it('reject target scope=global -> validation_error (relacje są ściśle intra-project)', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('relation-global-model'));
      const from = await seedApprovedMemory({
        header: 'Relacja from global test',
        body: 'T.',
        projectId: projectA.projectId,
      });
      const globalTo = await seedApprovedMemory({ header: 'Relacja to global', body: 'T.', scope: 'global', projectId: null });

      await expect(
        admin.createRelation({ fromId: from.id, toId: globalTo.id, type: 'follows' }),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('reject cross-project (obie pamięci scope=project, różne projekty) -> validation_error', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('relation-crossproject-model'));
      const from = await seedApprovedMemory({ header: 'Relacja from cross', body: 'T.', projectId: projectA.projectId });
      const to = await seedApprovedMemory({ header: 'Relacja to cross', body: 'T.', projectId: projectB.projectId });

      await expect(
        admin.createRelation({ fromId: from.id, toId: to.id, type: 'follows' }),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    it('reject self-loop (fromId === toId) -> validation_error', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('relation-selfloop-model'));
      const m = await seedApprovedMemory({ header: 'Relacja self-loop', body: 'T.', projectId: projectA.projectId });

      await expect(admin.createRelation({ fromId: m.id, toId: m.id, type: 'follows' })).rejects.toMatchObject({
        code: 'validation_error',
      });
    });

    it('reject duplikat (ten sam from/to/type) -> validation_error, oryginalna krawędź nietknięta', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('relation-duplicate-model'));
      const from = await seedApprovedMemory({ header: 'Relacja from dup', body: 'T.', projectId: projectA.projectId });
      const to = await seedApprovedMemory({ header: 'Relacja to dup', body: 'T.', projectId: projectA.projectId });

      const first = await admin.createRelation({ fromId: from.id, toId: to.id, type: 'context_for' });
      await expect(
        admin.createRelation({ fromId: from.id, toId: to.id, type: 'context_for' }),
      ).rejects.toMatchObject({ code: 'validation_error' });

      const rows = await db.select().from(memoryRelations).where(eq(memoryRelations.fromMemoryId, from.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.id);
    });

    it('createRelation z nieznanym fromId/toId -> not_found', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('relation-notfound-model'));
      const to = await seedApprovedMemory({ header: 'Relacja to notfound', body: 'T.', projectId: projectA.projectId });

      await expect(
        admin.createRelation({ fromId: 'mem_doesnotexist3', toId: to.id, type: 'follows' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('listRelations zwraca OBIE strony (outgoing+incoming) z metadanymi sąsiada', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('relation-list-model'));
      const center = await seedApprovedMemory({ header: 'Centrum relacji', body: 'T.', projectId: projectA.projectId });
      const outNeighbor = await seedApprovedMemory({
        header: 'Sasiad wychodzacy list',
        body: 'T.',
        projectId: projectA.projectId,
      });
      const inNeighbor = await seedApprovedMemory({
        header: 'Sasiad przychodzacy list',
        body: 'T.',
        projectId: projectA.projectId,
      });

      await admin.createRelation({ fromId: center.id, toId: outNeighbor.id, type: 'caused_by' });
      await admin.createRelation({ fromId: inNeighbor.id, toId: center.id, type: 'follows' });

      const relations = await admin.listRelations(center.id);
      expect(relations).toHaveLength(2);

      const outgoing = relations.find((r) => r.direction === 'outgoing');
      expect(outgoing?.neighbor.id).toBe(outNeighbor.id);
      expect(outgoing?.neighbor.header).toBe('Sasiad wychodzacy list');
      expect(outgoing?.type).toBe('caused_by');

      const incoming = relations.find((r) => r.direction === 'incoming');
      expect(incoming?.neighbor.id).toBe(inNeighbor.id);
      expect(incoming?.neighbor.header).toBe('Sasiad przychodzacy list');
      expect(incoming?.type).toBe('follows');
    });

    it('removeRelation usuwa wiersz i zapisuje audit relation_removed via=human', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('relation-remove-model'));
      const from = await seedApprovedMemory({ header: 'Relacja from remove', body: 'T.', projectId: projectA.projectId });
      const to = await seedApprovedMemory({ header: 'Relacja to remove', body: 'T.', projectId: projectA.projectId });
      const created = await admin.createRelation({ fromId: from.id, toId: to.id, type: 'follows' });

      await admin.removeRelation(created.id);

      const rows = await db.select().from(memoryRelations).where(eq(memoryRelations.id, created.id));
      expect(rows).toHaveLength(0);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'relation_removed'));
      const match = auditRows.find((a) => (a.metadata as { relationId?: string })?.relationId === created.id);
      expect(match).toBeDefined();
      expect([...match!.affectedIds].sort()).toEqual([from.id, to.id].sort());
      expect((match!.metadata as { via?: string }).via).toBe('human');
    });

    it('removeRelation z nieznanym relationId -> not_found', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('relation-remove-notfound-model'));
      await expect(admin.removeRelation('rel_doesnotexist9')).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('promoteToGlobal', () => {
    it('scope->global, project_id->null, version+1, revisions=promote, audit promote', async () => {
      const seeded = await seedApprovedMemory({ header: 'Do promocji', body: 'Tresc.', projectId: projectA.projectId });
      const { admin } = buildAdmin(new StubEmbeddingProvider('promote-model'));

      await admin.promoteToGlobal(seeded.id);

      const [row] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(row.scope).toBe('global');
      expect(row.projectId).toBeNull();
      expect(row.version).toBe(1);

      const revRows = await db.select().from(revisions).where(eq(revisions.memoryId, seeded.id));
      expect(revRows.some((r) => r.action === 'promote')).toBe(true);

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'promote'));
      expect(auditRows.some((a) => a.affectedIds.includes(seeded.id))).toBe(true);
    });

    it('promocja usuwa krawędzie dotykające promowanej pamięci (wychodzącą i przychodzącą) + audytuje relation_removed via=promote (roadmap v1.2, code review "promote zostawia martwe krawędzie")', async () => {
      const seeded = await seedApprovedMemory({
        header: 'Do promocji z relacjami',
        body: 'T.',
        projectId: projectA.projectId,
      });
      const outNeighbor = await seedApprovedMemory({
        header: 'Sasiad wychodzacy promote',
        body: 'T.',
        projectId: projectA.projectId,
      });
      const inNeighbor = await seedApprovedMemory({
        header: 'Sasiad przychodzacy promote',
        body: 'T.',
        projectId: projectA.projectId,
      });
      const { admin } = buildAdmin(new StubEmbeddingProvider('promote-relations-model'));

      const outRelation = await admin.createRelation({ fromId: seeded.id, toId: outNeighbor.id, type: 'follows' });
      const inRelation = await admin.createRelation({ fromId: inNeighbor.id, toId: seeded.id, type: 'caused_by' });

      await admin.promoteToGlobal(seeded.id);

      const [row] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(row.scope).toBe('global'); // memory faktycznie promowana mimo krawędzi

      // Krawędzie dotykające promowanej pamięci zniknęły — endpoint global byłby martwymi danymi
      // dla graph boostu (`fetchInSetEdges` wymaga OBU końców w tym samym per-project zapytaniu).
      const rows = await db
        .select()
        .from(memoryRelations)
        .where(or(eq(memoryRelations.fromMemoryId, seeded.id), eq(memoryRelations.toMemoryId, seeded.id)));
      expect(rows).toHaveLength(0);

      const removedAudit = await db.select().from(auditLog).where(eq(auditLog.eventType, 'relation_removed'));
      const removedOut = removedAudit.find(
        (r) => (r.metadata as { relationId?: string }).relationId === outRelation.id,
      );
      expect(removedOut).toBeDefined();
      expect([...removedOut!.affectedIds].sort()).toEqual([seeded.id, outNeighbor.id].sort());
      expect((removedOut!.metadata as { via?: string }).via).toBe('promote');
      const removedIn = removedAudit.find(
        (r) => (r.metadata as { relationId?: string }).relationId === inRelation.id,
      );
      expect(removedIn).toBeDefined();
      expect((removedIn!.metadata as { via?: string }).via).toBe('promote');
    });

    it('promocja już-global -> validation_error', async () => {
      const seeded = await seedApprovedMemory({ header: 'Juz global', body: 'T.', scope: 'global', projectId: null });
      const { admin } = buildAdmin(new StubEmbeddingProvider('promote-twice-model'));
      await expect(admin.promoteToGlobal(seeded.id)).rejects.toMatchObject({ code: 'validation_error' });
    });
  });

  describe('getMemoryDetail — bez bumpowania access_count/last_accessed_at (§Ryzyka planu)', () => {
    it('wielokrotny odczyt NIE zmienia access_count ani last_accessed_at', async () => {
      const seeded = await seedApprovedMemory({
        header: 'Nie bumpuj mnie',
        body: 'Tresc.',
        projectId: projectA.projectId,
        accessCount: 5,
      });
      const { admin } = buildAdmin(new StubEmbeddingProvider('no-bump-model'));

      const before = await admin.getMemoryDetail(seeded.id);
      expect(before.accessCount).toBe(5);
      await admin.getMemoryDetail(seeded.id);
      await admin.getMemoryDetail(seeded.id);

      const [row] = await db.select().from(memories).where(eq(memories.id, seeded.id));
      expect(row.accessCount).toBe(5);
      expect(row.lastAccessedAt).toBeNull();
    });

    it('nieistniejąca pamięć -> not_found (ToolError)', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('detail-missing-model'));
      await expect(admin.getMemoryDetail('mem_doesnotexist0')).rejects.toBeInstanceOf(ToolError);
    });
  });

  describe('listMemories — scope strict dla widoku projektu (FR-D6, §9.6 design-systemu)', () => {
    it("scope='project'+projectId nie przecieka pamięci global ani innego projektu", async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('list-scope-model'));
      const inProjectA = await seedApprovedMemory({ header: 'W projekcie A', body: 'T.', projectId: projectA.projectId });
      const inProjectB = await seedApprovedMemory({ header: 'W projekcie B', body: 'T.', projectId: projectB.projectId });
      const global = await seedApprovedMemory({ header: 'Global memory', body: 'T.', scope: 'global', projectId: null });

      const results = await admin.listMemories({ scope: 'project', projectId: projectA.projectId });
      const ids = results.map((r) => r.id);
      expect(ids).toContain(inProjectA.id);
      expect(ids).not.toContain(inProjectB.id);
      expect(ids).not.toContain(global.id);
    });

    it("scope='global' zwraca tylko global", async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('list-global-model'));
      const global = await seedApprovedMemory({ header: 'Global only test', body: 'T.', scope: 'global', projectId: null });
      const project = await seedApprovedMemory({ header: 'Project only test', body: 'T.', projectId: projectA.projectId });

      const results = await admin.listMemories({ scope: 'global' });
      const ids = results.map((r) => r.id);
      expect(ids).toContain(global.id);
      expect(ids).not.toContain(project.id);
    });

    it("scope='all'/undefined (Wszystkie) zwraca oba scope bez ograniczenia projektu", async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('list-all-model'));
      const inA = await seedApprovedMemory({ header: 'Wszystkie test A', body: 'T.', projectId: projectA.projectId });
      const inB = await seedApprovedMemory({ header: 'Wszystkie test B', body: 'T.', projectId: projectB.projectId });

      const results = await admin.listMemories({});
      const ids = results.map((r) => r.id);
      expect(ids).toContain(inA.id);
      expect(ids).toContain(inB.id);
    });

    it('nie zwraca body (lekki widok listy)', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('list-nobody-model'));
      await seedApprovedMemory({ header: 'Bez body w liscie', body: 'Sekretna tresc listy.', projectId: projectA.projectId });
      const results = await admin.listMemories({ scope: 'project', projectId: projectA.projectId });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect((r as unknown as { body?: string }).body).toBeUndefined();
      }
    });
  });

  describe('AuditService.query — filtry FR-D4', () => {
    it('filtruje po eventType i limit', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('audit-query-model'));
      await admin.humanCreate({ kind: 'fact', header: 'Audit query test', body: 'T.', scope: 'project', projectId: projectA.projectId });

      const rows = await audit.query({ eventType: 'human_edit', limit: 5 });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(5);
      expect(rows.every((r) => r.eventType === 'human_edit')).toBe(true);
    });

    it('filtruje po from/to (zakres czasu)', async () => {
      const future = new Date(Date.now() + 60_000);
      const rows = await audit.query({ from: future });
      expect(rows).toEqual([]);
    });

    it('filtruje po projectId (heurystyka actor=agent:<id> ∪ affected_ids ∩ pamięci projektu)', async () => {
      const { admin } = buildAdmin(new StubEmbeddingProvider('audit-project-model'));
      const created = await admin.humanCreate({
        kind: 'fact',
        header: 'Audit project filter test',
        body: 'T.',
        scope: 'project',
        projectId: projectB.projectId,
      });

      const rows = await audit.query({ projectId: projectB.projectId, eventType: 'human_edit' });
      expect(rows.some((r) => r.affectedIds.includes(created.id))).toBe(true);
    });
  });
});
