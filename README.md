# Context Keeper

Współdzielona, trwała, **human-gated** pamięć dla agentów AI, wystawiona jako remote MCP server.
Agenci szukają kontekstu i **proponują** zapisy; nic nie wchodzi do pamięci bez zatwierdzenia przez człowieka.

Specyfikacja: [`context/prd.md`](context/prd.md) · [`context/tech-stack.md`](context/tech-stack.md) · [`context/design-system.md`](context/design-system.md) · [`context/roadmap.md`](context/roadmap.md)

> **Status:** Faza 1 (Fundament) — host NestJS, model danych (Postgres + pgvector), Docker Compose, projekty + bearer tokeny.
> MCP, retrieval, kolejka akceptacji i dashboard dochodzą w Fazach 2–5.

## Stack

- **Backend:** NestJS 11 (Express) + TypeScript 5.9, monorepo pnpm (`apps/server`, docelowo `apps/web`)
- **Baza:** PostgreSQL 18 + pgvector 0.8 (+ `tsvector` FTS), Drizzle ORM + drizzle-kit
- **Deploy:** Docker Compose (opcjonalny Caddy w profilu `edge-proxy`, opcjonalny sidecar embeddingów w `local-embeddings`)

## Wymagania

- Node.js ≥ 22 (obraz produkcyjny używa 24), pnpm 10, Docker + Compose.

## Szybki start — Docker (zalecane)

```bash
cp .env.example .env          # dostosuj sekrety (SESSION_SECRET, DASHBOARD_PASSWORD)
docker compose up -d db       # Postgres + pgvector
docker compose run --rm app node dist/db/migrate.js   # migracje (schema + pgvector + FTS/HNSW)
docker compose up -d app      # serwer
curl localhost:3000/health    # -> {"status":"ok","db":"up"}

# Pierwszy projekt + bearer token (token pokazywany RAZ):
docker compose run --rm app node dist/cli.js create-project acme
```

> W kontenerze uruchamiamy `node dist/...` bezpośrednio (obraz prod nie zawiera pnpm/devDeps).
> Skróty `pnpm db:migrate` / `pnpm cli` działają w dev na hoście.

Profile opcjonalne:

```bash
docker compose --profile edge-proxy up -d           # Caddy przed app (tryb A)
docker compose --profile local-embeddings up -d     # sidecar TEI/bge-m3 (używany od Fazy 3)
```

## Szybki start — dev na hoście

```bash
pnpm install
cp .env.example .env          # DATABASE_URL wskazuje localhost:5432
docker compose up -d db       # sama baza w kontenerze
pnpm db:migrate:dev           # migracje z hosta (ts-node)
pnpm dev                      # nest start --watch  (http://localhost:3000)

pnpm --filter @context-keeper/server cli:dev create-project acme
```

## Skrypty (root)

| Skrypt | Rola |
|---|---|
| `pnpm dev` | serwer w trybie watch |
| `pnpm build` | build wszystkich paczek |
| `pnpm lint` / `pnpm test` | ESLint / vitest |
| `pnpm db:generate` | wygeneruj migrację z drizzle schema |
| `pnpm db:migrate` | zastosuj migracje (produkcyjnie, z `dist`) |
| `pnpm cli <cmd>` | CLI: `create-project`, `rotate-token`, `list-projects` |

## Struktura

```
apps/server/           NestJS host (MCP + JSON API + bundle SPA)
  src/config/          zod env (12-factor)
  src/db/              Drizzle schema + migracje + runner
  src/projects/        projekty, generacja/hash tokenów ck_, BearerGuard
  src/health/          /health
  src/cli/             komendy nest-commander
infra/Caddyfile        bundled edge (tryb A)
context/               specyfikacja (PRD, tech-stack, design system, roadmap)
```

## Bezpieczeństwo (Fundament)

- Bearer token `ck_` + 256-bit; w bazie tylko **SHA-256** (`token_hash`), nigdy plaintext.
- `.env` poza repo; sekrety nie trafiają do obrazu.
