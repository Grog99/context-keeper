import { describe, expect, it } from 'vitest';
import { envSchema, resolveDotenvCandidates } from '../src/config/env';

const BASE = { DATABASE_URL: 'postgres://unused' };

describe('envSchema — DB_AUTO_MIGRATE (§A, zBool factory)', () => {
  it('default true gdy nieustawione', () => {
    const env = envSchema.parse({ ...BASE });
    expect(env.DB_AUTO_MIGRATE).toBe(true);
  });

  it.each(['false', '0'])('%s -> false', (value) => {
    const env = envSchema.parse({ ...BASE, DB_AUTO_MIGRATE: value });
    expect(env.DB_AUTO_MIGRATE).toBe(false);
  });

  it.each(['1', 'true'])('%s -> true', (value) => {
    const env = envSchema.parse({ ...BASE, DB_AUTO_MIGRATE: value });
    expect(env.DB_AUTO_MIGRATE).toBe(true);
  });
});

describe('envSchema — TRUST_PROXY (zBool factory, backwards-compat default false)', () => {
  it('default false gdy nieustawione (zBool() bez argumentu)', () => {
    const env = envSchema.parse({ ...BASE });
    expect(env.TRUST_PROXY).toBe(false);
  });
});

describe('envSchema — EMBEDDING_PROVIDER=api @ DIM=1024 (superRefine)', () => {
  it('EMBEDDING_PRESET=api z pełną trójką + sekretami parsuje OK', () => {
    const env = envSchema.parse({
      ...BASE,
      EMBEDDING_PRESET: 'api',
      EMBEDDING_PROVIDER: 'api',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIM: '1024',
      EMBEDDING_API_KEY: 'sk-test',
      EMBEDDING_API_URL: 'https://api.openai.com/v1/embeddings',
    });
    expect(env.EMBEDDING_PROVIDER).toBe('api');
    expect(env.EMBEDDING_MODEL).toBe('text-embedding-3-small');
    expect(env.EMBEDDING_DIM).toBe(1024);
  });

  it('provider=api z EMBEDDING_DIM=1536 rzuca (kolumna wektorowa jest na sztywno vector(1024))', () => {
    const parsed = envSchema.safeParse({
      ...BASE,
      EMBEDDING_PROVIDER: 'api',
      EMBEDDING_DIM: '1536',
      EMBEDDING_API_KEY: 'sk-test',
      EMBEDDING_API_URL: 'https://api.openai.com/v1/embeddings',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'EMBEDDING_DIM')).toBe(true);
    }
  });

  it('provider=local (default) dalej parsuje bez zmian — backwards-compat', () => {
    const env = envSchema.parse({ ...BASE });
    expect(env.EMBEDDING_PROVIDER).toBe('local');
    expect(env.EMBEDDING_MODEL).toBe('bge-m3');
    expect(env.EMBEDDING_DIM).toBe(1024);
  });
});

describe('resolveDotenvCandidates — fallback na korzeń monorepo', () => {
  it('bez DOTENV_PATH próbuje cwd, a potem korzenia monorepo — w tej kolejności', () => {
    // `pnpm --filter <pkg>` (rootowy `pnpm dev`) startuje z cwd=apps/server, gdzie `.env` nie ma;
    // repo trzyma go w korzeniu, więc bez drugiego kandydata start pada na brak DATABASE_URL.
    expect(resolveDotenvCandidates(undefined)).toEqual(['.env', '../../.env']);
  });

  it('cwd ma pierwszeństwo przed korzeniem — produkcja (`.env` w WORKDIR) nie zmienia zachowania', () => {
    expect(resolveDotenvCandidates(undefined)[0]).toBe('.env');
  });

  it('jawny DOTENV_PATH wyłącza fallback — zła ścieżka ma dać twardy fail, nie cichy inny plik', () => {
    expect(resolveDotenvCandidates('/etc/context-keeper/.env')).toEqual(['/etc/context-keeper/.env']);
  });

  it('zwraca kopię, nie współdzieloną stałą — mutacja wyniku nie truje kolejnych wywołań', () => {
    resolveDotenvCandidates(undefined).push('/tmp/wstrzyknięte');
    expect(resolveDotenvCandidates(undefined)).toEqual(['.env', '../../.env']);
  });
});
