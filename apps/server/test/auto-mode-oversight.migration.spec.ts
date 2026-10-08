import { rmSync } from 'node:fs';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUpTo, REAL_MIGRATIONS_FOLDER } from './helpers/migrations';

/**
 * Migracja 0020 (roadmap v1.6, A3+A4 „nadzór po fakcie": `proposals.token_id` + FK `SET NULL` + indeks częściowy
 * `proposals_project_auto_held_idx` + backfill tokena z audytu `proposal_created`) jako REALNY UPGRADE z 0019
 * na bazie z danymi. Backfill ma uzupełnić token TYLKO dla propozycji agenta create/update, których token jeszcze istnieje.
 */
describe('migracja 0020 — upgrade 0019 → 0020 na niepustej bazie (testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tmpFolder: string | undefined;

  async function seedProposal(id: string, type: string, origin: string, auditTokenId: string | null): Promise<void> {
    await pool.query(
      `INSERT INTO proposals (id, type, origin, status, payload, scope, project_id)
       VALUES ($1, $2::proposal_type, $3::proposal_origin, 'pending', '{}'::jsonb, 'project', 'proj_a')`,
      [id, type, origin],
    );
    await pool.query(
      `INSERT INTO audit_log (id, event_type, actor, affected_ids, metadata)
       VALUES ($1, 'proposal_created', 'agent:proj_a', '{}', $2::jsonb)`,
      [`evt_${id}`, JSON.stringify({ proposalId: id, ...(auditTokenId ? { tokenId: auditTokenId } : {}) })],
    );
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    tmpFolder = await migrateUpTo(pool, '0020_');

    await pool.query("INSERT INTO projects (id, name, slug) VALUES ('proj_a', 'A', 'proj-a')");
    await pool.query(
      `INSERT INTO project_tokens (id, project_id, token_hash, label) VALUES ('tok_live', 'proj_a', 'hash_live', 'live')`,
    );
    await seedProposal('prop_create', 'create', 'agent', 'tok_live');
    await seedProposal('prop_update', 'update', 'agent', 'tok_live');
    await seedProposal('prop_missing_token', 'create', 'agent', 'tok_deleted'); // token już nie istnieje
    await seedProposal('prop_no_token', 'create', 'agent', null); // stary audyt bez tokena
    await seedProposal('prop_nightly', 'delete', 'nightly', 'tok_live'); // tylko agent create/update
    await seedProposal('prop_create_project', 'create_project', 'agent', 'tok_live');

    // Realny upgrade: tylko wpis 0020 (osobna transakcja drizzle) nad istniejącymi wierszami.
    await migrate(drizzle(pool), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (tmpFolder) rmSync(tmpFolder, { recursive: true, force: true });
  });

  async function tokenOf(id: string): Promise<string | null> {
    const { rows } = await pool.query<{ token_id: string | null }>('SELECT token_id FROM proposals WHERE id = $1', [id]);
    return rows[0].token_id;
  }

  it('backfill: agent create i update dostają token z audytu proposal_created', async () => {
    expect(await tokenOf('prop_create')).toBe('tok_live');
    expect(await tokenOf('prop_update')).toBe('tok_live');
  });

  it('backfill pomija: nieistniejący token, brak tokena w audycie, nocny job i create_project', async () => {
    expect(await tokenOf('prop_missing_token')).toBeNull();
    expect(await tokenOf('prop_no_token')).toBeNull();
    expect(await tokenOf('prop_nightly')).toBeNull();
    expect(await tokenOf('prop_create_project')).toBeNull();
  });

  it('FK token_id: nieistniejący token odrzucony (23503), usunięcie tokena zeruje kolumnę (SET NULL)', async () => {
    await expect(pool.query("UPDATE proposals SET token_id = 'tok_nope' WHERE id = 'prop_no_token'")).rejects.toMatchObject({
      code: '23503',
    });
    await pool.query("DELETE FROM project_tokens WHERE id = 'tok_live'");
    expect(await tokenOf('prop_create')).toBeNull();
    expect(await tokenOf('prop_update')).toBeNull();
  });

  it('indeks częściowy proposals_project_auto_held_idx istnieje (predykat auto_hold_reasons IS NOT NULL)', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'proposals_project_auto_held_idx'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('(project_id, created_at)');
    expect(rows[0].indexdef).toContain('auto_hold_reasons IS NOT NULL');
  });

  it('dane sprzed migracji nietknięte', async () => {
    const props = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM proposals');
    expect(props.rows[0].n).toBe(6);
  });
});
