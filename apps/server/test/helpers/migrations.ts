import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

/** Prawdziwy katalog migracji serwera. */
export const REAL_MIGRATIONS_FOLDER = resolve(process.cwd(), 'src/db/migrations');

/**
 * Stosuje migracje PRZED wpisem o tagu zaczynającym się od `beforeTagPrefix` (np. `'0013_'` → 0000…0012),
 * z tymczasowego katalogu z obciętym journalem. Zwraca ścieżkę katalogu do sprzątnięcia
 * (`rmSync(..., { recursive: true, force: true })`). Kolejne `migrate(db, { migrationsFolder:
 * REAL_MIGRATIONS_FOLDER })` stosuje już tylko brakujące wpisy — czyli test REALNEGO upgrade'u
 * (osobna transakcja drizzle tylko z nowymi migracjami), a nie świeżej bazy.
 */
export async function migrateUpTo(pool: Pool, beforeTagPrefix: string): Promise<string> {
  const tmpFolder = mkdtempSync(join(tmpdir(), 'ck-mig-pre-'));
  try {
    mkdirSync(join(tmpFolder, 'meta'));
    const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const idx = journal.entries.findIndex((e) => e.tag.startsWith(beforeTagPrefix));
    if (idx < 0) {
      throw new Error(`Brak wpisu ${beforeTagPrefix}* w meta/_journal.json — test migracji nie ma czego sprawdzać.`);
    }
    const pre = journal.entries.slice(0, idx);
    for (const entry of pre) {
      copyFileSync(join(REAL_MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(tmpFolder, `${entry.tag}.sql`));
    }
    writeFileSync(join(tmpFolder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: pre }, null, 2));
    await migrate(drizzle(pool), { migrationsFolder: tmpFolder });
    return tmpFolder;
  } catch (err) {
    rmSync(tmpFolder, { recursive: true, force: true });
    throw err;
  }
}
