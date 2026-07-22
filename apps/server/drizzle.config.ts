import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// Wczytaj .env dla lokalnego `drizzle-kit` (generate jest offline, ale credentials bywają potrzebne).
const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
if (existsSync('.env') && typeof loader === 'function') {
  try {
    loader('.env');
  } catch {
    /* ignore */
  }
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://ck:ck@localhost:5432/context_keeper',
  },
});
