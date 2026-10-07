import { rmSync } from 'node:fs';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUpTo, REAL_MIGRATIONS_FOLDER } from './helpers/migrations';

/**
 * Migracja 0019 (roadmap v1.6, A2 „auto mode": `projects.auto_mode`/`auto_mode_daily_limit`,
 * `proposals.auto_hold_reasons`/`auto_approved_at`, `memories.auto_approved_at` + indeksy częściowe + CHECK-i)
 * jako REALNY UPGRADE z 0018 na bazie z danymi. Wiersze sprzed migracji muszą dostać wartości domyślne
 * (auto mode wyłączony, limit 50) i NULL-e w nowych kolumnach, a CHECK-i muszą działać po upgrade'dzie.
 */
describe('migracja 0019 — upgrade 0018 → 0019 na niepustej bazie (testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tmpFolder: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    tmpFolder = await migrateUpTo(pool, '0019_');

    await pool.query("INSERT INTO projects (id, name, slug) VALUES ('proj_a', 'A', 'proj-a')");
    await pool.query(
      `INSERT INTO memories (id, header, body, kind, scope, project_id, status, source)
       VALUES ('mem_a', 'h', 'b', 'fact', 'project', 'proj_a', 'approved', 'human')`,
    );
    await pool.query(
      `INSERT INTO proposals (id, type, origin, status, payload, scope, project_id)
       VALUES ('prop_a', 'create', 'agent', 'pending', '{}'::jsonb, 'project', 'proj_a')`,
    );

    // Realny upgrade: tylko wpis 0019 (osobna transakcja drizzle) nad istniejącymi wierszami.
    await migrate(drizzle(pool), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (tmpFolder) rmSync(tmpFolder, { recursive: true, force: true });
  });

  it('istniejący projekt: auto_mode=false, auto_mode_daily_limit=50', async () => {
    const { rows } = await pool.query<{ auto_mode: boolean; auto_mode_daily_limit: number }>(
      "SELECT auto_mode, auto_mode_daily_limit FROM projects WHERE id = 'proj_a'",
    );
    expect(rows[0]).toEqual({ auto_mode: false, auto_mode_daily_limit: 50 });
  });

  it('istniejące proposals/memories: nowe kolumny NULL (bez backfillu)', async () => {
    const p = await pool.query<{ auto_hold_reasons: string[] | null; auto_approved_at: Date | null }>(
      "SELECT auto_hold_reasons, auto_approved_at FROM proposals WHERE id = 'prop_a'",
    );
    expect(p.rows[0]).toEqual({ auto_hold_reasons: null, auto_approved_at: null });
    const m = await pool.query<{ auto_approved_at: Date | null }>(
      "SELECT auto_approved_at FROM memories WHERE id = 'mem_a'",
    );
    expect(m.rows[0].auto_approved_at).toBeNull();
  });

  it('CHECK projects_auto_mode_daily_limit_check: 0 i 10001 odrzucone, 1 i 10000 przyjęte', async () => {
    for (const bad of [0, 10001, -5]) {
      await expect(
        pool.query('UPDATE projects SET auto_mode_daily_limit = $1 WHERE id = $2', [bad, 'proj_a']),
      ).rejects.toMatchObject({ code: '23514' });
    }
    for (const ok of [1, 10000, 50]) {
      await pool.query('UPDATE projects SET auto_mode_daily_limit = $1 WHERE id = $2', [ok, 'proj_a']);
    }
  });

  it('CHECK auto_hold_reasons: wszystkie pięć powodów (w tym auto_failed) przyjęte; nieznany i pusta tablica odrzucone', async () => {
    await pool.query(
      `UPDATE proposals SET auto_hold_reasons = ARRAY['near_duplicate','not_computed','human_target','daily_limit','auto_failed'] WHERE id = 'prop_a'`,
    );
    await pool.query(`UPDATE proposals SET auto_hold_reasons = ARRAY['auto_failed'] WHERE id = 'prop_a'`);
    await expect(
      pool.query(`UPDATE proposals SET auto_hold_reasons = ARRAY['nieznany'] WHERE id = 'prop_a'`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`UPDATE proposals SET auto_hold_reasons = ARRAY['near_duplicate','nieznany'] WHERE id = 'prop_a'`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`UPDATE proposals SET auto_hold_reasons = '{}'::text[] WHERE id = 'prop_a'`),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE proposals SET auto_hold_reasons = NULL WHERE id = 'prop_a'`);
  });

  it('CHECK proposals_auto_state_check: auto_approved_at i auto_hold_reasons nigdy naraz', async () => {
    await expect(
      pool.query(
        `UPDATE proposals SET auto_approved_at = now(), auto_hold_reasons = ARRAY['daily_limit'] WHERE id = 'prop_a'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE proposals SET auto_approved_at = now() WHERE id = 'prop_a'`);
    await expect(
      pool.query(`UPDATE proposals SET auto_hold_reasons = ARRAY['daily_limit'] WHERE id = 'prop_a'`),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE proposals SET auto_approved_at = NULL WHERE id = 'prop_a'`);
  });

  it('indeksy częściowe istnieją', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('memories_auto_approved_at_idx', 'proposals_project_auto_approved_idx')`,
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'memories_auto_approved_at_idx',
      'proposals_project_auto_approved_idx',
    ]);
  });

  it('dane sprzed migracji nietknięte', async () => {
    const mems = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM memories');
    const props = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM proposals');
    expect(mems.rows[0].n).toBe(1);
    expect(props.rows[0].n).toBe(1);
  });
});
