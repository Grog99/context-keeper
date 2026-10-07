import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { envSchema } from '../src/config/env';

/**
 * Parytet `envSchema` ↔ `.env.example` ↔ `app.environment` w plikach compose.
 *
 * Obraz Dockera nie zawiera `.env` (`.dockerignore`), a lokalny compose nie ma `env_file` — do
 * kontenera trafia WYŁĄCZNIE jawna lista `environment:`. Zmienna dodana do `env.ts` i `.env.example`,
 * ale nie do compose, jest po cichu ignorowana i appka działa na defaultach (tak zgubiły się
 * `PUBLIC_MCP_URL`, `RATE_LIMIT_*`, `TOKEN_GRACE_PERIOD_HOURS`). Coolify dokłada `env_file: .env`
 * do każdego serwisu sam, ale deklaracja `${X:-default}` i tak jest potrzebna, żeby zmienna
 * pojawiła się w jego UI.
 *
 * Nowa zmienna w schemacie => dopisz ją do `.env.example` i do `app.environment` we WSZYSTKICH
 * plikach z `COMPOSE_FILES` (z tym samym defaultem), albo dodaj do jednej z list wyjątków niżej
 * z uzasadnieniem.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');

const COMPOSE_FILES = [
  'docker-compose.yml',
  'deploy/docker-compose.coolify.yml',
  'deploy/docker-compose.coolify-nginx.yml',
] as const;
type ComposeFile = (typeof COMPOSE_FILES)[number];

/** Klucze schematu, których appka NIE czyta — kontrakt dla skryptów/schedulera na hoście
 * (`infra/backup.sh`, crontab, `install.sh`) albo dla samego Compose. Nie muszą być w kontenerze. */
const HOST_ONLY = new Set([
  'NIGHTLY_CRON',
  'NIGHTLY_TZ',
  'BACKUP_DIR',
  'BACKUP_RETENTION_DAILY_DAYS',
  'BACKUP_RETENTION_WEEKLY_WEEKS',
  'BACKUP_CRON',
  'BACKUP_TZ',
  'RCLONE_REMOTE',
  'BACKUP_OFFSITE_CMD',
  'COMPOSE_PROFILES',
  'ACME_EMAIL',
]);

/** Wyjątki per plik: zmienna czytana przez appkę, ale bez sensu w danym wariancie deployu. */
const NOT_APPLICABLE: Partial<Record<ComposeFile, Record<string, string>>> = {
  'deploy/docker-compose.coolify.yml': {
    ACME_DOMAIN: 'brak bundled Caddy (tryb A) — TLS robi proxy Coolify',
    EMBEDDING_BASE_URL: 'EMBEDDING_PROVIDER przypięty na api — sidecar TEI nie istnieje',
  },
  'deploy/docker-compose.coolify-nginx.yml': {
    ACME_DOMAIN: 'brak bundled Caddy (tryb A) — TLS robi Pangolin',
    EMBEDDING_BASE_URL: 'EMBEDDING_PROVIDER przypięty na api — sidecar TEI nie istnieje',
  },
};

/** Świadomie inny default w danym pliku niż w schemacie. */
const DEFAULT_OVERRIDES: Partial<Record<ComposeFile, Record<string, string>>> = {
  // Kontener to deploy, nie dev — schemat domyślnie zakłada `development` (pnpm dev na hoście).
  'docker-compose.yml': { NODE_ENV: 'production' },
  'deploy/docker-compose.coolify.yml': { EMBEDDING_MODEL: 'text-embedding-3-small' },
  'deploy/docker-compose.coolify-nginx.yml': { EMBEDDING_MODEL: 'text-embedding-3-small' },
};

/** Klucze w `app.environment`, które nie są konfiguracją appki (magic-env Coolify). */
const COMPOSE_ONLY_APP_KEYS = new Set(['SERVICE_FQDN_APP_3000', 'SERVICE_FQDN_APP_3001']);

/** Klucze `.env.example` konsumowane tylko przez Compose (serwis `db`, porty na hoście). */
const COMPOSE_ONLY_EXAMPLE_KEYS = new Set([
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'DB_PORT',
  'HTTP_PORT',
  'HTTPS_PORT',
]);

const SCHEMA_KEYS = Object.keys(envSchema.shape);
const APP_KEYS = SCHEMA_KEYS.filter((k) => !HOST_ONLY.has(k));

/** Defaulty schematu jako stringi (tak, jak lądują w env). `undefined` = pole bez defaultu. */
const SCHEMA_DEFAULTS: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(envSchema.parse({ DATABASE_URL: 'postgres://unused' }))
    .filter(([k]) => k !== 'DATABASE_URL')
    .map(([k, v]) => [k, v === undefined ? undefined : String(v)]),
);

/** `${NAME}`, `${NAME:-default}`, `${NAME-default}`, `${NAME:?}` — jedna referencja na całą wartość. */
const SIMPLE_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)(.*)|:?\?.*)?\}$/;

function readAppEnvironment(file: ComposeFile): Record<string, string> {
  const doc = parse(readFileSync(join(REPO_ROOT, file), 'utf8')) as {
    services: { app: { environment: Record<string, string | number | boolean> } };
  };
  return Object.fromEntries(
    Object.entries(doc.services.app.environment).map(([k, v]) => [k, String(v)]),
  );
}

describe.each(COMPOSE_FILES)('compose ↔ envSchema: %s', (file) => {
  const env = readAppEnvironment(file);
  const notApplicable = NOT_APPLICABLE[file] ?? {};
  const overrides = DEFAULT_OVERRIDES[file] ?? {};

  it('app.environment zawiera każdą zmienną czytaną przez appkę', () => {
    const missing = APP_KEYS.filter((k) => !(k in env) && !(k in notApplicable));
    expect(missing, `brak w ${file} → services.app.environment`).toEqual([]);
  });

  it('app.environment nie zawiera kluczy spoza schematu', () => {
    const unknown = Object.keys(env).filter(
      (k) => !SCHEMA_KEYS.includes(k) && !COMPOSE_ONLY_APP_KEYS.has(k),
    );
    expect(unknown).toEqual([]);
  });

  it('wyjątki NOT_APPLICABLE nie są martwe (klucz nadal w schemacie, a nie w compose)', () => {
    for (const key of Object.keys(notApplicable)) {
      expect(SCHEMA_KEYS, key).toContain(key);
      expect(env, key).not.toHaveProperty(key);
    }
  });

  it('referencja ${X} wskazuje tę samą zmienną, a default zgadza się ze schematem', () => {
    const problems: string[] = [];
    for (const [key, raw] of Object.entries(env)) {
      if (!SCHEMA_KEYS.includes(key)) continue;
      const m = SIMPLE_REF.exec(raw);
      if (!m) continue; // wartość przypięta na sztywno albo złożona (DATABASE_URL) — świadomie
      const [, refName, operator, fallback] = m;
      if (refName !== key) problems.push(`${key}: referencja do ${refName}`);
      if (operator === undefined) continue; // `${X}` / `${X:?}` — bez defaultu w compose
      const expected = key in overrides ? overrides[key] : (SCHEMA_DEFAULTS[key] ?? '');
      if (fallback !== expected) {
        problems.push(`${key}: default w compose "${fallback}" ≠ schemat "${expected}"`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('.env.example ↔ envSchema', () => {
  const example = Object.fromEntries(
    readFileSync(join(REPO_ROOT, '.env.example'), 'utf8')
      .split(/\r?\n/)
      .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );

  it('ten sam zestaw kluczy (poza kluczami tylko dla Compose)', () => {
    const exampleKeys = Object.keys(example).filter((k) => !COMPOSE_ONLY_EXAMPLE_KEYS.has(k));
    expect([...exampleKeys].sort()).toEqual([...SCHEMA_KEYS].sort());
  });

  it('wartości przykładowe zgadzają się z defaultami schematu', () => {
    const problems = Object.entries(SCHEMA_DEFAULTS)
      .filter(([k, def]) => def !== undefined && k in example && example[k] !== def)
      .map(([k, def]) => `${k}: .env.example "${example[k]}" ≠ schemat "${def}"`);
    expect(problems).toEqual([]);
  });
});
