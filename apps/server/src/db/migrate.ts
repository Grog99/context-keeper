import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { loadEnv } from '../config/env';

/**
 * Klucz advisory locka zarezerwowany WYŁĄCZNIE dla migracji (odrębny namespace od
 * `NIGHTLY_LOCK_KEY` = 87_942_611 w `nightly.service.ts` — nigdy nie reużywać między mechanizmami).
 * Blokujący (`pg_advisory_lock`, nie `_try_`): równoległe boot-y (repliki / rolling deploy Coolify)
 * mają się SERIALIZOWAĆ (czekać), nie skipować migrację po cichu.
 */
export const MIGRATION_LOCK_KEY = 91_734_204;

/**
 * Kandydaci na katalog migracji w kolejności prób, liczeni względem katalogu modułu.
 *
 * `<baseDir>/migrations` — kopia z kroku build (`scripts/copy-migrations.mjs`). Trafia w produkcji
 * (`dist/db/migrations` w obrazie) oraz przy CLI przez ts-node (`src/db/migrations`).
 *
 * `<baseDir>/../../src/db/migrations` — źródło w repo, widziane z `dist/db`. Potrzebne, bo
 * `nest start --watch` (czyli `pnpm dev`) NIE woła `copy-migrations.mjs`, a `nest-cli.json` ma
 * `deleteOutDir: true` — więc watch kasuje `dist` i zjada nawet kopię z wcześniejszego builda.
 * Bez tego auto-migracja w `main.ts` wywala bootstrap na „Can't find meta/_journal.json".
 */
export function migrationsFolderCandidates(baseDir: string): string[] {
  return [join(baseDir, 'migrations'), join(baseDir, '..', '..', 'src', 'db', 'migrations')];
}

/**
 * Pierwszy kandydat, który wygląda na PRAWDZIWY katalog migracji drizzle — samo istnienie katalogu
 * nie wystarcza, bo `deleteOutDir` potrafi zostawić pusty `dist/db/migrations`; wyznacznikiem jest
 * `meta/_journal.json`, czyli dokładnie plik, na którego brak skarży się drizzle.
 *
 * Gdy nie ma żadnego, zwraca kandydata pierwszego — niech błąd przyjdzie z drizzle'a i wskaże
 * ścieżkę produkcyjną, zamiast mylić wskazaniem fallbacku, którego w obrazie i tak nie ma.
 */
export function resolveMigrationsFolder(baseDir: string = __dirname): string {
  const candidates = migrationsFolderCandidates(baseDir);
  return candidates.find((dir) => existsSync(join(dir, 'meta', '_journal.json'))) ?? candidates[0];
}

/**
 * Rdzeń runnera migracji — wołany zarówno przez CLI (`main` niżej) jak i in-process z `main.ts`
 * (auto-migracja przed nasłuchem, §A). Migracje SQL kopiowane do dist w kroku build
 * (scripts/copy-migrations.mjs); w trybie watch bierzemy je wprost ze źródeł — patrz
 * `resolveMigrationsFolder`.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  const migrationsFolder = resolveMigrationsFolder();
  const lock = await pool.connect();
  try {
    // Blokujący lock: równoległe boot-y (repliki / rolling deploy) serializują się (czekają), nie skipują.
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    console.log(`[migrate] applying migrations from ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    console.log('[migrate] done');
  } finally {
    // Session-level lock żyje na dedykowanym kliencie — ginie z połączeniem, brak zombie-locka.
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    lock.release();
    await pool.end();
  }
}

/**
 * Cienki CLI-entrypoint. Uruchamiany jako:
 *   - dev:    pnpm db:migrate:dev   (ts-node, __dirname = src/db)
 *   - docker: pnpm db:migrate       (node dist/db/migrate.js, __dirname = dist/db)
 */
async function main(): Promise<void> {
  const env = loadEnv();
  await runMigrations(env.DATABASE_URL);
}

// KRYTYCZNE: odpal `main` TYLKO gdy plik jest uruchomiony bezpośrednio jako CLI, NIE gdy jest
// importowany (np. `main.ts` importuje `runMigrations` do auto-migracji in-process) — bez tego
// guarda import wywołałby migrację DRUGI RAZ (raz przez CLI/compose serwis `migrate`, raz przez
// `main.ts`). `apps/server/package.json` ma `"type": "commonjs"`, więc `require.main === module`
// to poprawny idiom (CommonJS-owy, nie ESM).
if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}
