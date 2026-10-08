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

describe('envSchema — NEAR_DUPLICATE_DISTANCE (roadmap v1.6, A1)', () => {
  it('default 0.2 gdy nieustawione (zmierzone dla bge-m3)', () => {
    expect(envSchema.parse({ ...BASE }).NEAR_DUPLICATE_DISTANCE).toBe(0.2);
  });

  it('parsuje wartość z env (coerce)', () => {
    expect(envSchema.parse({ ...BASE, NEAR_DUPLICATE_DISTANCE: '0.25' }).NEAR_DUPLICATE_DISTANCE).toBe(0.25);
  });

  it('odrzuca 0 i wartość > 2 (dystans kosinusowy mieści się w [0, 2])', () => {
    expect(() => envSchema.parse({ ...BASE, NEAR_DUPLICATE_DISTANCE: '0' })).toThrow();
    expect(() => envSchema.parse({ ...BASE, NEAR_DUPLICATE_DISTANCE: '2.5' })).toThrow();
  });

  it('jest niezależny od NIGHTLY_DEDUP_DISTANCE', () => {
    const env = envSchema.parse({ ...BASE, NIGHTLY_DEDUP_DISTANCE: '0.001' });
    expect(env.NEAR_DUPLICATE_DISTANCE).toBe(0.2);
  });
});

describe('envSchema — NIGHTLY_CONFLICT_DISTANCE (roadmap v1.6, B3)', () => {
  it('default 0.23 gdy nieustawione (zmierzone dla bge-m3)', () => {
    expect(envSchema.parse({ ...BASE }).NIGHTLY_CONFLICT_DISTANCE).toBe(0.23);
  });

  it('parsuje wartość z env (coerce), np. 0.21 dla text-embedding-3-small', () => {
    expect(envSchema.parse({ ...BASE, NIGHTLY_CONFLICT_DISTANCE: '0.21' }).NIGHTLY_CONFLICT_DISTANCE).toBe(0.21);
  });

  it('odrzuca 0 i wartość > 2 (dystans kosinusowy mieści się w [0, 2])', () => {
    expect(() => envSchema.parse({ ...BASE, NIGHTLY_CONFLICT_DISTANCE: '0' })).toThrow();
    expect(() => envSchema.parse({ ...BASE, NIGHTLY_CONFLICT_DISTANCE: '2.5' })).toThrow();
  });

  it('jest niezależny od NIGHTLY_DEDUP_DISTANCE (brak cross-field: wartość <= dedup nie wywraca bootu)', () => {
    expect(envSchema.parse({ ...BASE, NIGHTLY_DEDUP_DISTANCE: '0.001' }).NIGHTLY_CONFLICT_DISTANCE).toBe(0.23);
    expect(() => envSchema.parse({ ...BASE, NIGHTLY_DEDUP_DISTANCE: '0.3', NIGHTLY_CONFLICT_DISTANCE: '0.1' })).not.toThrow();
  });
});

describe('envSchema — RATE_LIMIT_CREATE_PROJECT_PER_MIN (roadmap v1.5)', () => {
  it('default 3 gdy nieustawione', () => {
    expect(envSchema.parse({ ...BASE }).RATE_LIMIT_CREATE_PROJECT_PER_MIN).toBe(3);
  });

  it('parsuje wartość z env (coerce) i odrzuca nie-dodatnią', () => {
    expect(envSchema.parse({ ...BASE, RATE_LIMIT_CREATE_PROJECT_PER_MIN: '7' }).RATE_LIMIT_CREATE_PROJECT_PER_MIN).toBe(7);
    expect(() => envSchema.parse({ ...BASE, RATE_LIMIT_CREATE_PROJECT_PER_MIN: '0' })).toThrow();
  });
});

describe('envSchema — pusty string w opcjonalnych polach z formatem = nieustawione', () => {
  // `X=` z `.env.example` (process.loadEnvFile) i `${X:-}` w compose dają `''`, nie brak klucza.
  it('PUBLIC_MCP_URL="" -> undefined (zamiast "Invalid URL")', () => {
    expect(envSchema.parse({ ...BASE, PUBLIC_MCP_URL: '' }).PUBLIC_MCP_URL).toBeUndefined();
  });

  it('EMBEDDING_PRESET="" -> undefined (zamiast błędu enuma)', () => {
    expect(envSchema.parse({ ...BASE, EMBEDDING_PRESET: '' }).EMBEDDING_PRESET).toBeUndefined();
  });

  it('niepusty PUBLIC_MCP_URL nadal jest walidowany i normalizowany', () => {
    expect(envSchema.parse({ ...BASE, PUBLIC_MCP_URL: 'https://ck.example.com/mcp/' }).PUBLIC_MCP_URL).toBe(
      'https://ck.example.com',
    );
    expect(() => envSchema.parse({ ...BASE, PUBLIC_MCP_URL: 'nie-url' })).toThrow();
  });
});

describe('envSchema — SECRETS_ENCRYPTION_KEY (roadmap v1.6, G5)', () => {
  const KEY_44 = Buffer.alloc(32, 3).toString('base64'); // 44 znaki, padding '='
  const KEY_43 = Buffer.alloc(32, 250).toString('base64url'); // 43 znaki, url-safe bez paddingu

  it('nieustawiona -> undefined (appka startuje, zapis klucza API będzie odrzucany)', () => {
    expect(envSchema.parse({ ...BASE }).SECRETS_ENCRYPTION_KEY).toBeUndefined();
  });

  it("pusty string ('SECRETS_ENCRYPTION_KEY=' z compose) -> undefined", () => {
    expect(envSchema.parse({ ...BASE, SECRETS_ENCRYPTION_KEY: '' }).SECRETS_ENCRYPTION_KEY).toBeUndefined();
  });

  it('poprawny klucz 44-znakowy (openssl rand -base64 32) i 43-znakowy url-safe przechodzą', () => {
    expect(KEY_44).toHaveLength(44);
    expect(KEY_43).toHaveLength(43);
    expect(envSchema.parse({ ...BASE, SECRETS_ENCRYPTION_KEY: KEY_44 }).SECRETS_ENCRYPTION_KEY).toBe(KEY_44);
    expect(envSchema.parse({ ...BASE, SECRETS_ENCRYPTION_KEY: KEY_43 }).SECRETS_ENCRYPTION_KEY).toBe(KEY_43);
  });

  it.each([
    ['16-bajtowy klucz', Buffer.alloc(16, 1).toString('base64')],
    ['64-bajtowy klucz', Buffer.alloc(64, 1).toString('base64')],
    ['śmieci', 'to-nie-jest-klucz!!'],
    ['za krótki', 'abc'],
  ])('%s -> issue na ścieżce SECRETS_ENCRYPTION_KEY, bez wartości w komunikacie', (_label, value) => {
    const parsed = envSchema.safeParse({ ...BASE, SECRETS_ENCRYPTION_KEY: value });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path.join('.') === 'SECRETS_ENCRYPTION_KEY');
      expect(issue).toBeDefined();
      expect(issue!.message).not.toContain(value);
    }
  });
});
