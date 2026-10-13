import { rmSync } from 'node:fs';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUpTo, REAL_MIGRATIONS_FOLDER } from './helpers/migrations';
import { endPool } from './helpers/pg-teardown';

/**
 * Migracja 0021 (roadmap v1.8, ticket `journal-kind`: `memory_kind` + 'journal') jako REALNY UPGRADE z 0020 —
 * nie świeża baza. Drizzle stosuje oczekujące migracje w jednej transakcji, więc użycie nowej wartości enuma w
 * tej samej migracji (np. w predykacie indeksu, CHECK-u albo UPDATE) przeszłoby na świeżej bazie, a wywaliło
 * upgrade błędem 55P04 ("unsafe use of new value of enum type"). Ten test łapie dokładnie ten przypadek.
 * Prefiks `0021_` = następny numer po ostatniej migracji w `meta/_journal.json`; przy rebase'ie na nowszą bazę
 * (inna migracja v1.8 weszła wcześniej) prefiks przesuwa się razem z wygenerowaną migracją.
 *
 * Jeden test zamiast kilku: upgrade jest krokiem testu (nie `beforeAll`), żeby brak migracji dawał czerwony
 * TEST z czytelnym powodem, a nie pominięte testy po padniętym hooku.
 */
describe('migracja 0021 (journal-kind) — upgrade 0020 → 0021 na niepustej bazie (testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tmpFolder: string | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await endPool(pool);
    await container?.stop();
    if (tmpFolder) rmSync(tmpFolder, { recursive: true, force: true });
  });

  it("upgrade przechodzi bez 55P04; enum = fact, document, event, journal; stare wiersze nietknięte; po migracji INSERT z kind='journal' działa", async () => {
    tmpFolder = await migrateUpTo(pool, '0021_');

    // Stan sprzed migracji: projekt, zatwierdzony fakt i oczekująca propozycja `create` (fakt).
    await pool.query("INSERT INTO projects (id, name, slug) VALUES ('proj_old', 'Old', 'old-project')");
    await pool.query(
      `INSERT INTO memories (id, header, body, kind, scope, project_id, status, source)
       VALUES ('mem_old', 'Stary fakt', 'Treść sprzed migracji.', 'fact', 'project', 'proj_old', 'approved', 'agent')`,
    );
    await pool.query(
      `INSERT INTO proposals (id, type, origin, status, payload, scope, project_id)
       VALUES ('prop_old', 'create', 'agent', 'pending',
               '{"memoryId":"mem_pending","header":"h","body":"b","kind":"fact"}', 'project', 'proj_old')`,
    );

    // Realny upgrade: tylko nowa migracja, w jednej transakcji drizzle — musi przejść bez 55P04.
    await migrate(drizzle(pool), { migrationsFolder: REAL_MIGRATIONS_FOLDER });

    const enumRows = await pool.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'memory_kind' ORDER BY e.enumsortorder`,
    );
    expect(enumRows.rows.map((r) => r.enumlabel)).toEqual(['fact', 'document', 'event', 'journal']);

    const memRows = await pool.query("SELECT kind, status, header, body FROM memories WHERE id = 'mem_old'");
    expect(memRows.rows).toEqual([
      { kind: 'fact', status: 'approved', header: 'Stary fakt', body: 'Treść sprzed migracji.' },
    ]);
    const propRows = await pool.query("SELECT type, status, payload FROM proposals WHERE id = 'prop_old'");
    expect(propRows.rows).toEqual([
      {
        type: 'create',
        status: 'pending',
        payload: { memoryId: 'mem_pending', header: 'h', body: 'b', kind: 'fact' },
      },
    ]);

    // Osobna transakcja (autocommit) po migracji — nowa wartość jest już bezpieczna w użyciu.
    await pool.query(
      `INSERT INTO memories (id, header, body, kind, scope, project_id, status, source)
       VALUES ('mem_journal', 'Wpis dziennika', '## Done', 'journal', 'project', 'proj_old', 'approved', 'agent')`,
    );
    const journalRows = await pool.query("SELECT kind FROM memories WHERE id = 'mem_journal'");
    expect(journalRows.rows).toEqual([{ kind: 'journal' }]);
  });
});
