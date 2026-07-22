// Kopiuje zbudowaną SPA (apps/dashboard/dist) do dist/public po `nest build` (§M5 planu Fazy 5).
// Mirror `copy-migrations.mjs`: statyki nie przechodzą przez `tsc`, muszą trafić do obrazu osobno.
// `dashboard.module.ts` serwuje je przez `ServeStaticModule.forRoot({ rootPath: dist/public })`.
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');
const src = join(serverRoot, '..', 'dashboard', 'dist');
const dest = join(serverRoot, 'dist', 'public');

if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
  console.log(`[build] copied dashboard SPA -> ${dest}`);
} else {
  console.warn('[build] no apps/dashboard/dist to copy — build @context-keeper/dashboard first');
}
