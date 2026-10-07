import { rmSync } from 'node:fs';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUpTo, REAL_MIGRATIONS_FOLDER } from './helpers/migrations';

/**
 * Migracja 0017 (roadmap v1.6, ticket nightly-llm-provider: tabela `llm_settings` + dwie wartości
 * `audit_event_type`) jako REALNY UPGRADE z 0015 na bazie z danymi — nie świeża baza. Dane (projekt,
 * pamięć, wpis audytu) powstają PRZED migracją i muszą przeżyć nietknięte; zasiew wiersza instancji
 * i oba CHECK-i / unikalność `NULLS NOT DISTINCT` muszą działać na bazie po upgrade'dzie.
 */
describe('migracja 0017 — upgrade 0016 → 0017 na niepustej bazie (testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tmpFolder: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    tmpFolder = await migrateUpTo(pool, '0017_');

    await pool.query("INSERT INTO projects (id, name, slug) VALUES ('proj_a', 'A', 'proj-a')");
    await pool.query(
      `INSERT INTO memories (id, header, body, kind, scope, project_id, status, source)
       VALUES ('mem_a', 'h', 'b', 'fact', 'project', 'proj_a', 'approved', 'human')`,
    );
    await pool.query(
      `INSERT INTO audit_log (id, event_type, actor, affected_ids) VALUES ('evt_a', 'human_edit', 'human-dashboard', ARRAY['mem_a'])`,
    );

    // Realny upgrade: tylko wpis 0017 (osobna transakcja drizzle) nad istniejącymi wierszami.
    await migrate(drizzle(pool), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (tmpFolder) rmSync(tmpFolder, { recursive: true, force: true });
  });

  it('tabela llm_settings istnieje; wiersz instancji zasiany: id=global, project_id NULL, wyłączony, wartości domyślne', async () => {
    const { rows } = await pool.query<{
      id: string;
      project_id: string | null;
      enabled: boolean;
      endpoint: string | null;
      model: string | null;
      api_key_ciphertext: string | null;
      call_cap: number;
      timeout_ms: number;
    }>('SELECT * FROM llm_settings');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'global',
      project_id: null,
      enabled: false,
      endpoint: null,
      model: null,
      api_key_ciphertext: null,
      call_cap: 100,
      timeout_ms: 30000,
    });
  });

  it('enum audit_event_type zawiera llm_secret_skipped i instance_settings_changed', async () => {
    const { rows } = await pool.query<{ enumlabel: string }>(
      "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'audit_event_type'",
    );
    const labels = rows.map((r) => r.enumlabel);
    expect(labels).toContain('llm_secret_skipped');
    expect(labels).toContain('instance_settings_changed');
  });

  it('nowe wartości enuma są używalne po upgrade (zapis audytu)', async () => {
    await pool.query(
      `INSERT INTO audit_log (id, event_type, actor) VALUES ('evt_n1', 'llm_secret_skipped', 'nightly'), ('evt_n2', 'instance_settings_changed', 'human-dashboard')`,
    );
    const { rows } = await pool.query('SELECT id FROM audit_log WHERE id IN (\'evt_n1\', \'evt_n2\')');
    expect(rows).toHaveLength(2);
  });

  it('drugi wiersz instancji (project_id IS NULL) jest odrzucany — UNIQUE NULLS NOT DISTINCT', async () => {
    await expect(pool.query("INSERT INTO llm_settings (id) VALUES ('second')")).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('wiersz per projekt jest dozwolony (model per projekt nie jest blokowany), drugi dla tego samego projektu — nie', async () => {
    await pool.query("INSERT INTO llm_settings (id, project_id) VALUES ('llms_proj_a', 'proj_a')");
    await expect(
      pool.query("INSERT INTO llm_settings (id, project_id) VALUES ('llms_proj_a2', 'proj_a')"),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('usunięcie projektu kasuje jego wiersz ustawień (ON DELETE CASCADE), wiersz instancji zostaje', async () => {
    await pool.query("INSERT INTO projects (id, name, slug) VALUES ('proj_tmp', 'T', 'proj-tmp')");
    await pool.query("INSERT INTO llm_settings (id, project_id) VALUES ('llms_tmp', 'proj_tmp')");
    await pool.query("DELETE FROM projects WHERE id = 'proj_tmp'");
    const { rows } = await pool.query("SELECT id FROM llm_settings WHERE id IN ('llms_tmp', 'global')");
    expect(rows.map((r) => (r as { id: string }).id)).toEqual(['global']);
  });

  it('CHECK: enabled=true bez modelu/endpointu jest odrzucany (G14)', async () => {
    await expect(pool.query("UPDATE llm_settings SET enabled = true WHERE id = 'global'")).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      pool.query("UPDATE llm_settings SET enabled = true, endpoint = 'http://x/v1/chat/completions' WHERE id = 'global'"),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      "UPDATE llm_settings SET enabled = true, endpoint = 'http://x/v1/chat/completions', model = 'm' WHERE id = 'global'",
    );
    await pool.query("UPDATE llm_settings SET enabled = false, endpoint = NULL, model = NULL WHERE id = 'global'");
  });

  it('CHECK: call_cap i timeout_ms poza zakresem są odrzucane', async () => {
    for (const set of ['call_cap = 0', 'call_cap = 10001', 'timeout_ms = 999', 'timeout_ms = 300001']) {
      await expect(pool.query(`UPDATE llm_settings SET ${set} WHERE id = 'global'`)).rejects.toMatchObject({
        code: '23514',
      });
    }
  });

  it('dane sprzed migracji nietknięte', async () => {
    const mems = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM memories');
    const audit = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE id = 'evt_a'");
    const proj = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM projects WHERE id = 'proj_a'");
    expect(mems.rows[0].n).toBe(1);
    expect(audit.rows[0].n).toBe(1);
    expect(proj.rows[0].n).toBe(1);
  });
});
