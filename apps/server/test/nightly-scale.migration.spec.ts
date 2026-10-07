import { rmSync } from 'node:fs';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUpTo, REAL_MIGRATIONS_FOLDER } from './helpers/migrations';

/**
 * Migracja 0015 (nightly-scale, dług #5 i #7: GIN `fastupdate = off` na `audit_log.affected_ids` + btree
 * `proposals (status, created_at, id)`) jako REALNY UPGRADE z 0014 na bazie z danymi — nie świeża baza.
 * Dane (projekt, pamięci w trzech statusach, audyt z `affected_ids`, propozycje) powstają PRZED
 * migracją i muszą przeżyć nietknięte; nowe indeksy muszą być budowane nad istniejącymi wierszami.
 */
describe('migracja 0015 — upgrade 0014 → 0015 na niepustej bazie (testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tmpFolder: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    tmpFolder = await migrateUpTo(pool, '0015_');

    await pool.query("INSERT INTO projects (id, name, slug) VALUES ('proj_a', 'A', 'proj-a')");
    for (const [id, status] of [
      ['mem_appr', 'approved'],
      ['mem_arch', 'archived'],
      ['mem_purg', 'purged'],
    ] as const) {
      await pool.query(
        `INSERT INTO memories (id, header, body, kind, scope, project_id, status, source)
         VALUES ($1, 'h', 'b', 'fact', 'project', 'proj_a', $2, 'human')`,
        [id, status],
      );
    }
    const audit = (id: string, actor: string, ids: string[]) =>
      pool.query(
        `INSERT INTO audit_log (id, event_type, actor, affected_ids) VALUES ($1, 'human_edit', $2, $3::text[])`,
        [id, actor, ids],
      );
    await audit('evt_appr', 'human-dashboard', ['mem_appr']);
    await audit('evt_arch', 'human-dashboard', ['mem_arch', 'mem_other']);
    await audit('evt_purg', 'human-dashboard', ['mem_purg']);
    await audit('evt_other', 'human-dashboard', ['mem_other']);
    await audit('evt_empty', 'human-dashboard', []);
    for (const [id, status] of [
      ['prop_p1', 'pending'],
      ['prop_p2', 'pending'],
      ['prop_a1', 'approved'],
    ] as const) {
      await pool.query(
        `INSERT INTO proposals (id, type, origin, status, payload, scope, project_id)
         VALUES ($1, 'create', 'agent', $2, '{"header":"h"}', 'project', 'proj_a')`,
        [id, status],
      );
    }

    // Realny upgrade: tylko wpis 0015 (osobna transakcja drizzle) nad istniejącymi wierszami.
    await migrate(drizzle(pool), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (tmpFolder) rmSync(tmpFolder, { recursive: true, force: true });
  });

  it('audit_affected_ids_idx istnieje i jest GIN na affected_ids', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_affected_ids_idx'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('USING gin (affected_ids)');
  });

  it('audit_affected_ids_idx ma fastupdate = off (stabilny koszt GIN niezależnie od pending list)', async () => {
    const { rows } = await pool.query<{ reloptions: string[] | null }>(
      "SELECT reloptions FROM pg_class WHERE relname = 'audit_affected_ids_idx' AND relkind = 'i'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reloptions).toContain('fastupdate=false');
  });

  it('proposals_status_created_id_idx istnieje jako btree (status, created_at, id); stary indeks statusu zostaje', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'proposals' AND indexname IN ('proposals_status_created_id_idx', 'proposals_status_idx')",
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.get('proposals_status_created_id_idx')).toContain('USING btree (status, created_at, id)');
    expect(byName.has('proposals_status_idx')).toBe(true);
  });

  it('dane sprzed migracji nietknięte', async () => {
    const audit = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log');
    const props = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM proposals');
    const mems = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM memories');
    expect(audit.rows[0].n).toBe(5);
    expect(props.rows[0].n).toBe(3);
    expect(mems.rows[0].n).toBe(3);
  });

  it('predykat filtra projektu (`affected_ids && ARRAY(SELECT … project_id)`) zwraca zdarzenia pamięci projektu w każdym statusie', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM audit_log
        WHERE affected_ids && ARRAY(SELECT m.id FROM memories m WHERE m.project_id = $1)
        ORDER BY id`,
      ['proj_a'],
    );
    expect(rows.map((r) => r.id)).toEqual(['evt_appr', 'evt_arch', 'evt_purg']);
  });

  it('pusty zbiór pamięci projektu -> brak dopasowań', async () => {
    await pool.query("INSERT INTO projects (id, name, slug) VALUES ('proj_empty', 'E', 'proj-empty')");
    const { rows } = await pool.query(
      `SELECT id FROM audit_log
        WHERE affected_ids && ARRAY(SELECT m.id FROM memories m WHERE m.project_id = $1)`,
      ['proj_empty'],
    );
    expect(rows).toHaveLength(0);
  });
});
