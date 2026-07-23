import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/common/tokens';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import { projects } from '../src/db/schema';
import { ProjectsService } from '../src/projects/projects.service';

describe('ProjectsService (integration, testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let service: ProjectsService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    service = new ProjectsService(db);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('migracje tworzą rozszerzenie vector, kolumnę FTS i indeks HNSW', async () => {
    const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    expect(ext.rowCount).toBe(1);

    const fts = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='fts'",
    );
    expect(fts.rowCount).toBe(1);

    const hnsw = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname='embeddings_vector_hnsw_idx'",
    );
    expect(hnsw.rowCount).toBe(1);
    expect(hnsw.rows[0].indexdef).toContain('hnsw');
    expect(hnsw.rows[0].indexdef).toContain('vector_cosine_ops');
  });

  it('createProject: zapisuje hash tokena, nigdy plaintext', async () => {
    const { project, token } = await service.createProject('acme');
    expect(project.id).toMatch(/^proj_/);
    expect(token).toMatch(/^ck_/);

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenStatus).toBe('active');
  });

  it('resolveProjectByToken: właściwy projekt dla poprawnego tokena, null dla złego', async () => {
    const { project, token } = await service.createProject('beta');
    const found = await service.resolveProjectByToken(token);
    expect(found?.id).toBe(project.id);

    expect(await service.resolveProjectByToken('ck_' + 'x'.repeat(43))).toBeNull();
    expect(await service.resolveProjectByToken('garbage')).toBeNull();
  });

  it('rotateToken: hard-cutover — stary token przestaje działać, nowy działa', async () => {
    const { project, token: oldToken } = await service.createProject('gamma');
    const { token: newToken } = await service.rotateToken(project.id);

    expect(await service.resolveProjectByToken(oldToken)).toBeNull();
    expect((await service.resolveProjectByToken(newToken))?.id).toBe(project.id);
  });

  describe('updateProject (roadmap v1.2, "kind=event episodic" — dialog szczegółów projektu)', () => {
    it('default includeEventsInDefaultSearch=false dla nowo utworzonego projektu', async () => {
      const { project } = await service.createProject('delta-default');
      expect(project.includeEventsInDefaultSearch).toBe(false);
    });

    it('przełącza includeEventsInDefaultSearch true/false, listProjects odzwierciedla nową wartość', async () => {
      const { project } = await service.createProject('delta-toggle');

      const enabled = await service.updateProject(project.id, { includeEventsInDefaultSearch: true });
      expect(enabled.includeEventsInDefaultSearch).toBe(true);

      const listed = await service.listProjects();
      expect(listed.find((p) => p.id === project.id)?.includeEventsInDefaultSearch).toBe(true);

      const disabled = await service.updateProject(project.id, { includeEventsInDefaultSearch: false });
      expect(disabled.includeEventsInDefaultSearch).toBe(false);
    });

    it('pole pominięte (undefined) -> no-op, zwraca bieżący wiersz bez zmian', async () => {
      const { project } = await service.createProject('delta-noop');
      await service.updateProject(project.id, { includeEventsInDefaultSearch: true });

      const result = await service.updateProject(project.id, {});
      expect(result.includeEventsInDefaultSearch).toBe(true); // niezmienione przez no-op wywołanie
    });

    it('nieznane id -> NotFoundException', async () => {
      await expect(
        service.updateProject('proj_doesnotexist0', { includeEventsInDefaultSearch: true }),
      ).rejects.toThrow();
    });
  });
});
