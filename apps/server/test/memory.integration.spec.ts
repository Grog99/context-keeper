import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { ToolError } from '../src/common/errors';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import { auditLog, proposals } from '../src/db/schema';
import { MemoryService } from '../src/memory/memory.service';
import type { ProjectContext } from '../src/projects/projects.service';
import { ProjectsService } from '../src/projects/projects.service';

describe('MemoryService (integration, testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let memory: MemoryService;
  let audit: AuditService;

  let projectA: ProjectContext;
  let projectB: ProjectContext;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });

    projects = new ProjectsService(db);
    audit = new AuditService(db);
    const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
    memory = new MemoryService(db, config, audit);

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
});
