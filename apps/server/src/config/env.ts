import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Boolean z env: pusty/undefined -> false; "1"/"true"/"yes"/"on" -> true.
 * (z.coerce.boolean() traktuje "false" jako true — dlatego własny preprocess.)
 */
const zBool = z.preprocess((v) => {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  return Boolean(v);
}, z.boolean());

/**
 * Kontrakt konfiguracji (12-factor). Kanon i komentarze: `.env.example`.
 * Wartości progów/limitów to knoby dostrajane na realnych danych (PRD §11).
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Porty — app słucha plain HTTP na własnym origin; TLS/rozdział ekspozycji na proxy (§9).
    PORT_MCP: z.coerce.number().int().positive().default(3000),
    PORT_DASHBOARD: z.coerce.number().int().positive().default(3001),
    // true gdy TLS terminowany upstream (tryb B) — honoruj X-Forwarded-* (§9).
    TRUST_PROXY: zBool,

    // Baza
    DATABASE_URL: z.string().min(1, 'DATABASE_URL jest wymagany'),

    // Embeddingi — provider + preset (pełne wpięcie w Fazie 3; spójność walidowana już teraz).
    EMBEDDING_PROVIDER: z.enum(['local', 'api']).default('local'),
    EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),
    EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),
    EMBEDDING_API_KEY: z.string().optional(),
    EMBEDDING_SAVE_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),

    // Limity wejścia (FR-V1)
    BODY_MAX_FACT: z.coerce.number().int().positive().default(8192),
    BODY_MAX_DOCUMENT: z.coerce.number().int().positive().default(262144),
    TAGS_MAX: z.coerce.number().int().positive().default(10),
    TAG_MAX_LEN: z.coerce.number().int().positive().default(40),

    // Nocny job (§8)
    NIGHTLY_CRON: z.string().min(1).default('0 3 * * *'),
    NIGHTLY_TZ: z.string().min(1).default('Europe/Warsaw'),

    // Rate limiting per token (§10)
    RATE_LIMIT_SAVE_PER_MIN: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_SEARCH_PER_MIN: z.coerce.number().int().positive().default(120),
    RATE_LIMIT_GET_PER_MIN: z.coerce.number().int().positive().default(240),

    // Dashboard / sesja (używane od Fazy 5) — wymagane w produkcji.
    DASHBOARD_PASSWORD: z.string().optional(),
    SESSION_SECRET: z.string().optional(),

    // Compose / edge
    COMPOSE_PROFILES: z.string().optional(),
    ACME_DOMAIN: z.string().optional(),
    ACME_EMAIL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.EMBEDDING_PROVIDER === 'api' && !env.EMBEDDING_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMBEDDING_API_KEY'],
        message: 'EMBEDDING_API_KEY jest wymagany gdy EMBEDDING_PROVIDER=api',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.SESSION_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_SECRET'],
          message: 'SESSION_SECRET jest wymagany w produkcji',
        });
      }
      if (!env.DASHBOARD_PASSWORD) {
        ctx.addIssue({
          code: 'custom',
          path: ['DASHBOARD_PASSWORD'],
          message: 'DASHBOARD_PASSWORD (seed) jest wymagany w produkcji',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Ładuje .env do process.env jeśli plik istnieje (dev). W produkcji env wstrzykuje Compose. */
function loadDotenvIfPresent(): void {
  const path = process.env.DOTENV_PATH ?? '.env';
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (existsSync(path) && typeof loader === 'function') {
    try {
      loader(path);
    } catch {
      // brak wpływu — env może przyjść z innego źródła
    }
  }
}

/** Parsuje i waliduje process.env. Twardy fail z czytelnym komunikatem przy błędzie. */
export function loadEnv(): Env {
  loadDotenvIfPresent();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Niepoprawna konfiguracja środowiska:\n${issues}`);
  }
  return parsed.data;
}
