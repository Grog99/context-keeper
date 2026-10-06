import { rmSync } from 'node:fs';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUpTo, REAL_MIGRATIONS_FOLDER } from './helpers/migrations';

/**
 * Migracja 0013 (roadmap v1.5, scope B: `proposal_type` + 'create_project' i partial unique index na
 * `payload->>'slug'`) jako REALNY UPGRADE z 0012 — nie świeża baza. To jedyny test, który łapie błąd
 * 55P04 ("unsafe use of new value of enum type"): drizzle stosuje oczekujące migracje w jednej
 * transakcji, a indeks z predykatem `type = 'create_project'` przechodzi na świeżej bazie (enum
 * tworzony w tej samej transakcji), ale wywala upgrade, w którym wartość enuma dodaje dopiero 0013.
 * Gdyby ktoś "naprawił" predykat z powrotem na literał enuma, ten test się wywali.
 */
describe('migracja 0013 — upgrade 0012 → 0013 na niepustej bazie (testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tmpFolder: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    tmpFolder = await migrateUpTo(pool, '0013_');

    // Stan sprzed 0013: projekt + oczekująca propozycja `create` (payload pamięci, bez klucza `slug`).
    await pool.query("INSERT INTO projects (id, name, slug) VALUES ('proj_old', 'Old', 'old-project')");
    await pool.query(
      `INSERT INTO proposals (id, type, origin, status, payload, scope, project_id)
       VALUES ('prop_old', 'create', 'agent', 'pending', '{"memoryId":"mem_old","header":"h","body":"b"}', 'project', 'proj_old')`,
    );

    // Realny upgrade: tylko wpis 0013, w jednej transakcji drizzle — musi przejść bez 55P04.
    await migrate(drizzle(pool), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (tmpFolder) rmSync(tmpFolder, { recursive: true, force: true });
  });

  it('enum proposal_type zawiera create_project', async () => {
    const { rows } = await pool.query<{ enumlabel: string }>(
      "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'proposal_type'",
    );
    expect(rows.map((r) => r.enumlabel)).toContain('create_project');
  });

  it('partial unique index istnieje, jest UNIQUE i jego predykat NIE odwołuje się do wartości enuma', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'proposals_create_project_slug_pending_key'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('UNIQUE');
    expect(rows[0].indexdef).toContain("'slug'");
    expect(rows[0].indexdef).toContain('pending');
    expect(rows[0].indexdef).not.toContain('create_project\'::proposal_type');
  });

  it('stara propozycja sprzed migracji nietknięta', async () => {
    const { rows } = await pool.query<{ type: string; status: string; payload: { memoryId: string } }>(
      "SELECT type, status, payload FROM proposals WHERE id = 'prop_old'",
    );
    expect(rows).toEqual([{ type: 'create', status: 'pending', payload: { memoryId: 'mem_old', header: 'h', body: 'b' } }]);
  });

  it('indeks egzekwuje unikalność slugu wśród pending create_project (i tylko tam)', async () => {
    const insert = (id: string, status: string, payload: object, type = 'create_project') =>
      pool.query(
        "INSERT INTO proposals (id, type, origin, status, payload, scope) VALUES ($1, $2, 'agent', $3, $4, 'global')",
        [id, type, status, JSON.stringify(payload)],
      );
    await insert('prop_cp1', 'pending', { name: 'A', slug: 'dup-slug' });
    await expect(insert('prop_cp2', 'pending', { name: 'B', slug: 'dup-slug' })).rejects.toMatchObject({
      code: '23505',
      constraint: 'proposals_create_project_slug_pending_key',
    });
    await insert('prop_cp3', 'rejected', { name: 'C', slug: 'dup-slug' }); // nie-pending nie koliduje
    await insert('prop_cp4', 'pending', { name: 'D', slug: 'other-slug' });
    // Payloady pamięci (bez klucza `slug`) nie wchodzą do indeksu — wiele pending obok siebie.
    await insert('prop_m1', 'pending', { memoryId: 'mem_a' }, 'delete');
    await insert('prop_m2', 'pending', { memoryId: 'mem_b' }, 'delete');
  });
});
