// Kopiuje migracje SQL (src/db/migrations) do dist/db/migrations po `nest build`.
// tsc kompiluje tylko .ts → .js; pliki .sql muszą trafić do obrazu osobno.
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'src', 'db', 'migrations');
const dest = join(root, 'dist', 'db', 'migrations');

if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
  console.log(`[build] copied migrations -> ${dest}`);
} else {
  console.warn('[build] no migrations folder to copy (src/db/migrations missing)');
}
