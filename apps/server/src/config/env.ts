import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Fabryka boolean z env: pusty/undefined/null -> `defaultValue`; "1"/"true"/"yes"/"on" -> true;
 * inny string -> false. (z.coerce.boolean() traktuje "false" jako true — dlatego własny preprocess.)
 * Fabryka (nie stały schemat) bo preprocess koerciuje undefined->false SAM, zanim jakikolwiek
 * `.default()` na zewnątrz zdąży zadziałać — jedyny sposób na non-false default to wpiąć go
 * w sam preprocess.
 */
function zBool(defaultValue = false) {
  return z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return defaultValue;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    return Boolean(v);
  }, z.boolean());
}

/**
 * Trójka implikowana przez preset (§7 tech-stack) — PRESET jest tylko wygodą instalatora,
 * PROVIDER/MODEL/DIM zostają autorytatywne (walidacja w superRefine niżej).
 * `api` celuje w DIM=1024 (Matryoshka — `text-embedding-3-*` zwraca skrócony/renormalizowany
 * wektor przez parametr `dimensions`, patrz `api.provider.ts`), więc pasuje pod fizyczną kolumnę
 * `vector(1024)` bez migracji. `english` (DIM=384) NADAL implikuje wymiar inny niż kolumna — Faza 3
 * nie robi cross-dimension migracji (ALTER COLUMN + rebuild HNSW) — dozwolone do skonfigurowania,
 * ale realny re-embed pod nim czeka na tę migrację.
 */
const EMBEDDING_PRESET_TRIO = {
  multilingual: { provider: 'local', model: 'bge-m3', dim: 1024 },
  english: { provider: 'local', model: 'bge-small-en-v1.5', dim: 384 },
  api: { provider: 'api', model: 'text-embedding-3-small', dim: 1024 },
} as const;

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
    TRUST_PROXY: zBool(),

    // Baza
    DATABASE_URL: z.string().min(1, 'DATABASE_URL jest wymagany'),
    // Auto-migracja przy starcie appki (in-process, przed nasłuchem) — §A. Default TRUE.
    DB_AUTO_MIGRATE: zBool(true),

    // Embeddingi — provider + preset (Faza 3). Trójka PROVIDER+MODEL+DIM jest autorytatywna;
    // PRESET to tylko wygoda instalatora (§7 tech-stack) — walidowana przeciw trójce w superRefine.
    EMBEDDING_PROVIDER: z.enum(['local', 'api']).default('local'),
    EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),
    EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),
    EMBEDDING_API_KEY: z.string().optional(),
    EMBEDDING_SAVE_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
    EMBEDDING_PRESET: z.enum(['multilingual', 'english', 'api']).optional(),
    // TEI sidecar (provider=local); zewnętrzne API (provider=api) — osobny URL, bo różne kontrakty HTTP.
    EMBEDDING_BASE_URL: z.string().min(1).default('http://embeddings:80'),
    EMBEDDING_API_URL: z.string().optional(),
    // Budżet ramienia wektorowego przy SEARCH — odrębny od SAVE (search jest sync w ścieżce agenta).
    EMBEDDING_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(800),

    // Hybrid retrieval (§6 tech-stack, FR-R2-R5) — RRF + top-k/kandydaci ramienia wektorowego.
    RRF_K: z.coerce.number().int().positive().default(60),
    SEARCH_TOP_K: z.coerce.number().int().positive().default(10),
    SEARCH_VECTOR_CANDIDATES: z.coerce.number().int().positive().default(50),

    // Limity wejścia (FR-V1)
    BODY_MAX_FACT: z.coerce.number().int().positive().default(8192),
    BODY_MAX_DOCUMENT: z.coerce.number().int().positive().default(262144),
    TAGS_MAX: z.coerce.number().int().positive().default(10),
    TAG_MAX_LEN: z.coerce.number().int().positive().default(40),

    // Nocny job (§8, Faza 6). NIGHTLY_CRON/NIGHTLY_TZ to kontrakt dla ZEWNĘTRZNEGO schedulera
    // (Faza 8, installer/infra) — `run-nightly` CLI ich nie czyta, odpala się natychmiast po
    // wywołaniu. Progi poniżej to knoby dostrajane na realnych danych (PRD §11), wartości domyślne
    // to punkt startowy (plan Fazy 6 §5 pkt 1, ZAAKCEPTOWANE bez zmian).
    NIGHTLY_CRON: z.string().min(1).default('0 3 * * *'),
    NIGHTLY_TZ: z.string().min(1).default('Europe/Warsaw'),
    // Próg "near-identical" dla ANN dedup (dystans kosinusowy `<=>`, 0=identyczne, 2=przeciwne) —
    // celowo wąski ("scan broadly, merge narrowly", FR-N3): tylko niemal identyczne treści.
    NIGHTLY_DEDUP_DISTANCE: z.coerce.number().positive().default(0.05),
    // Liczba sąsiadów pobieranych per fakt w zapytaniu ANN (LIMIT), zanim odfiltrujemy do NIGHTLY_DEDUP_DISTANCE.
    NIGHTLY_ANN_NEIGHBORS: z.coerce.number().int().positive().default(5),
    // Rozmiar strony paginacji przy skanowaniu approved facts (jak --batch w `reembed`).
    NIGHTLY_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    // Prune (RecencyPruneScorer, v1): minimalny wiek pamięci, zanim w ogóle podlega ocenie.
    NIGHTLY_PRUNE_MIN_AGE_DAYS: z.coerce.number().int().positive().default(30),
    // Prune: ile dni bez odczytu (albo NIGDY nieodczytana) liczy się jako "stale".
    NIGHTLY_PRUNE_STALE_DAYS: z.coerce.number().int().positive().default(90),
    // Prune: maksymalny access_count, żeby wciąż kwalifikować się do usunięcia (0 = tylko faktycznie nietknięte).
    NIGHTLY_PRUNE_MAX_ACCESS: z.coerce.number().int().nonnegative().default(0),
    // Flood backstop (plan §5 pkt 6): limit NOWYCH proposali tworzonych w jednym przebiegu —
    // reszta wykrytych warunków wraca w kolejnym stateless re-scanie, nie ginie po cichu.
    NIGHTLY_MAX_PROPOSALS_PER_RUN: z.coerce.number().int().positive().default(200),
    // Retencja `search_events` (instrumentacja "Pomiary", roadmap v1.1) — raw rows starsze niż N dni
    // są pruned nocnym jobem (piggyback na istniejący przebieg, bez nowego schedulera).
    SEARCH_EVENTS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

    // Backup (NFR-5, §9 tech-stack; plan Fazy 7). Appka TYCH zmiennych nie czyta — to kontrakt dla
    // `infra/backup.sh` + przyszłego host-side schedulera (Faza 8), dokładnie jak NIGHTLY_CRON/TZ.
    BACKUP_DIR: z.string().min(1).default('./backups'),
    // Tiered retention (plan §1a): daily = zachowaj WSZYSTKIE dumpy młodsze niż N dni; weekly =
    // zachowaj po jednym (najnowszym) reprezentancie na tydzień ISO w oknie
    // [DAILY_DAYS, DAILY_DAYS + WEEKLY_WEEKS*7) dni. Cutoff kasowania jest WYPROWADZONY, bez
    // trzeciej redundantnej zmiennej. WEEKLY_WEEKS=0 degraduje łagodnie do płaskiej retencji
    // DAILY_DAYS dni.
    BACKUP_RETENTION_DAILY_DAYS: z.coerce.number().int().positive().default(7),
    BACKUP_RETENTION_WEEKLY_WEEKS: z.coerce.number().int().nonnegative().default(4),
    BACKUP_CRON: z.string().min(1).default('0 4 * * *'),
    BACKUP_TZ: z.string().min(1).default('Europe/Warsaw'),
    // Offsite — pluggable hook (nic wymuszone na sztywno, plan §1 pkt "Offsite"). RCLONE_REMOTE
    // (np. "s3:bucket/ck") -> `rclone copy`; BACKUP_OFFSITE_CMD -> dowolna komenda użytkownika,
    // wołana z "$1" = path do dumpa (patrz .env.example). Gdy oba ustawione, BACKUP_OFFSITE_CMD ma
    // pierwszeństwo. Oba opcjonalne — brak obu = tylko lokalny dump (retencja i tak działa).
    RCLONE_REMOTE: z.string().optional(),
    BACKUP_OFFSITE_CMD: z.string().optional(),

    // Rate limiting per token (§10)
    RATE_LIMIT_SAVE_PER_MIN: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_SEARCH_PER_MIN: z.coerce.number().int().positive().default(120),
    RATE_LIMIT_GET_PER_MIN: z.coerce.number().int().positive().default(240),
    // Throttle PRE-AUTH per IP na /mcp — backstop DoS zanim BearerGuard dotknie DB przy każdym
    // (dobrze sformatowanym, ale nieważnym) tokenie. Fidelity per-IP wymaga TRUST_PROXY=true za
    // zaufanym, jedynym proxy-ingres; bez tego degraduje się do coarse limitu per-instancja
    // (wciąż ogranicza łączny nieuwierzytelniony ruch). Osobny od limitów per-token wyżej.
    RATE_LIMIT_MCP_IP_PER_MIN: z.coerce.number().int().positive().default(300),

    // Dashboard / sesja (Faza 5) — DASHBOARD_PASSWORD/SESSION_SECRET wymagane w produkcji.
    DASHBOARD_PASSWORD: z.string().optional(),
    SESSION_SECRET: z.string().optional(),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
    DASHBOARD_COOKIE_NAME: z.string().min(1).default('ck_session'),

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
    if (env.EMBEDDING_PROVIDER === 'api' && !env.EMBEDDING_API_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMBEDDING_API_URL'],
        message: 'EMBEDDING_API_URL jest wymagany gdy EMBEDDING_PROVIDER=api',
      });
    }
    if (env.EMBEDDING_PROVIDER === 'api' && env.EMBEDDING_DIM !== 1024) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMBEDDING_DIM'],
        message:
          'EMBEDDING_DIM musi być 1024 dla EMBEDDING_PROVIDER=api — kolumna wektorowa jest na sztywno ' +
          'vector(1024); text-embedding-3-* zwraca skrócony/renormalizowany wektor przez parametr `dimensions`.',
      });
    }
    if (env.EMBEDDING_PRESET) {
      const expected = EMBEDDING_PRESET_TRIO[env.EMBEDDING_PRESET];
      const matches =
        env.EMBEDDING_PROVIDER === expected.provider &&
        env.EMBEDDING_MODEL === expected.model &&
        env.EMBEDDING_DIM === expected.dim;
      if (!matches) {
        ctx.addIssue({
          code: 'custom',
          path: ['EMBEDDING_PRESET'],
          message:
            `EMBEDDING_PRESET=${env.EMBEDDING_PRESET} wymaga PROVIDER=${expected.provider}, ` +
            `MODEL=${expected.model}, DIM=${expected.dim} — trójka w env jest z nim niespójna ` +
            `(popraw PROVIDER/MODEL/DIM albo usuń EMBEDDING_PRESET)`,
        });
      }
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
