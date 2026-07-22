import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { loadEnv } from '../config/env';

/**
 * Runner migracji. Uruchamiany jako:
 *   - dev:    pnpm db:migrate:dev   (ts-node, __dirname = src/db)
 *   - docker: pnpm db:migrate       (node dist/db/migrate.js, __dirname = dist/db)
 * Migracje SQL kopiowane do dist w kroku build (scripts/copy-migrations.mjs).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool);
  const migrationsFolder = join(__dirname, 'migrations');

  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  try {
    await migrate(db, { migrationsFolder });
    console.log('[migrate] done');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
