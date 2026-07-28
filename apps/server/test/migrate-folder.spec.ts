import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolderCandidates, resolveMigrationsFolder } from '../src/db/migrate';

/**
 * Regresja: `pnpm dev` (`nest start --watch`) padał na starcie z „Can't find meta/_journal.json".
 * Watch nie woła `scripts/copy-migrations.mjs`, a `nest-cli.json` ma `deleteOutDir: true`, więc
 * `dist/db/migrations` nie powstaje — runner musi umieć sięgnąć po źródła w repo.
 */
describe('resolveMigrationsFolder — fallback na źródła w trybie watch', () => {
  const SRC_DB = join(__dirname, '..', 'src', 'db');

  it('kopia z builda ma pierwszeństwo przed źródłami — produkcja bez zmian', () => {
    const [first] = migrationsFolderCandidates('/app/dist/db');
    expect(first).toBe(join('/app/dist/db', 'migrations'));
  });

  it('drugi kandydat to katalog migracji w src, liczony z dist/db', () => {
    const [, second] = migrationsFolderCandidates(join('/repo', 'apps', 'server', 'dist', 'db'));
    expect(second).toBe(join('/repo', 'apps', 'server', 'src', 'db', 'migrations'));
  });

  it('gdy kopii z builda nie ma, schodzi do src — realny FS repo', () => {
    // Katalog dwa poziomy pod `apps/server`, tak jak `dist/db`, ale świadomie NIE `dist`:
    // test nie może zależeć od tego, czy ktoś odpalił wcześniej `pnpm build` (wtedy `dist/db/
    // migrations` istnieje i fallback słusznie się nie odpala).
    const noBuild = join(__dirname, '..', '__bez-builda__', 'db');
    expect(existsSync(join(noBuild, 'migrations', 'meta', '_journal.json'))).toBe(false);
    expect(resolveMigrationsFolder(noBuild)).toBe(join(SRC_DB, 'migrations'));
  });

  it('z src/db (CLI przez ts-node) bierze kandydata pierwszego, bez schodzenia niżej', () => {
    expect(resolveMigrationsFolder(SRC_DB)).toBe(join(SRC_DB, 'migrations'));
  });

  it('gdy żaden kandydat nie ma journala, zwraca ścieżkę produkcyjną — błąd drizzle ma wskazać ją', () => {
    const nowhere = join(__dirname, '__nie-istnieje__', 'db');
    expect(resolveMigrationsFolder(nowhere)).toBe(join(nowhere, 'migrations'));
  });
});
