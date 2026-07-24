# Context Keeper

Współdzielona, trwała, **human-gated** pamięć dla agentów AI, wystawiona jako remote MCP server.

Agenci (Claude Code, Codex, Cursor…) zaczynają każdą sesję od zera i gubią decyzje, konwencje oraz
„dlaczego tak" projektu. Context Keeper daje im **wspólną pamięć**: agenci **szukają** w niej
kontekstu i **proponują** zapisy — ale nic nie trafia do pamięci bez zatwierdzenia przez człowieka.

Specyfikacja: [`context/prd.md`](context/prd.md) · [`context/tech-stack.md`](context/tech-stack.md) · [`context/design-system.md`](context/design-system.md) · [`context/roadmap.md`](context/roadmap.md)

> **Status:** v1 domknięte i wdrożone (dogfooding live). Następny etap: v1.1
> (walidacja dogfoodingu) — patrz [`context/roadmap.md`](context/roadmap.md).

## Najważniejsze funkcje

- **Human-gate** — każdy zapis (agenta i nocnego joba) ląduje w kolejce akceptacji; do pamięci
  trafia dopiero po zatwierdzeniu przez człowieka. To główna obrona przed memory-poisoning, nie tylko proces.
- **Remote MCP** — narzędzia `search_memory` / `get_memory` / `save_memory`; podłączasz dowolnego
  klienta MCP przez `.mcp.json` + bearer token.
- **Hybrid retrieval** — wektor (pgvector) + full-text (tsvector) łączone przez RRF; wielojęzyczne
  embeddingi (bge-m3, PL+EN) domyślnie.
- **Skaner sekretów** — propozycje z tokenami/kluczami są odrzucane na wejściu, nie zapisywane.
- **Dashboard recenzenta** — przegląd kolejki propozycji, akceptacja/edycja/odrzucenie i podgląd stanu pamięci.
- **Nocny job** — dedup/merge/prune jako *proposer*, nie executor: też przechodzi przez kolejkę,
  nigdy nie mutuje pamięci sam.

## Stack

- **Backend:** NestJS (Express) + TypeScript, monorepo pnpm (`apps/server`, `apps/dashboard`)
- **Baza:** PostgreSQL + pgvector (+ `tsvector` FTS), Drizzle ORM
- **Deploy:** Docker Compose (opcjonalny Caddy w profilu `edge-proxy`, sidecar embeddingów w `local-embeddings`)

Konkretne wersje i uzasadnienia: [`context/tech-stack.md`](context/tech-stack.md). Wymagania: Node ≥ 22, pnpm 10, Docker + Compose.

## Szybki start — instalator (zalecane)

```bash
./install.sh
```

Cienki generator nad `.env` + profilami Compose (POSIX `sh` + `openssl`) — **nie zastępuje**
`.env.example` (kanon configu), tylko go templatuje. Dwie fazy: **(1)** offline — kilka pytań
(tryb edge, preset embeddingów, harmonogram nocnego joba, nazwa pierwszego projektu) i bezpieczne
generowanie sekretów; **(2)** opcjonalnie — `docker compose up -d`, migracje, `create-project`
(token wypisywany **raz**). Idempotentny: re-run z istniejącym `.env` pyta zachować/regenerować,
nigdy nie nadpisuje cicho. Flagi (`-y`, `--start`/`--no-start`, `--dry-run`) — `./install.sh --help`.

## Szybki start — Docker, manualnie (fallback / zaawansowany)

```bash
cp .env.example .env          # dostosuj sekrety (SESSION_SECRET, DASHBOARD_PASSWORD)
docker compose up -d db       # Postgres + pgvector
docker compose up -d app      # serwer — auto-migruje przy starcie (DB_AUTO_MIGRATE=true, domyślnie)
curl localhost:3000/health    # -> {"status":"ok","db":"up"}

# Pierwszy projekt + bearer token (token pokazywany RAZ):
docker compose run --rm app node dist/cli.js create-project acme
```

> Domyślnie `app` migruje bazę in-process przed nasłuchem — nie musisz odpalać osobnego kroku.
> Przy `DB_AUTO_MIGRATE=false` migrujesz sam PRZED startem appki:
> `docker compose run --rm app node dist/db/migrate.js`.

Profile opcjonalne:

```bash
docker compose --profile edge-proxy up -d           # Caddy przed app (tryb A)
docker compose --profile local-embeddings up -d     # sidecar TEI/bge-m3
```

## Szybki start — dev na hoście

```bash
pnpm install
cp .env.example .env          # DATABASE_URL wskazuje localhost:5432
docker compose up -d db       # sama baza w kontenerze
pnpm --filter @context-keeper/server db:migrate:dev   # migracje z hosta (ts-node)
pnpm dev                      # nest start --watch  (http://localhost:3000)

pnpm --filter @context-keeper/server cli:dev create-project acme
```

## Pamięć projektu (dogfooding)

Repo używa **własnej wdrożonej instancji** jako trwałej pamięci projektu, wystawionej jako serwer
MCP `context-keeper` (config w commitowanym [`.mcp.json`](.mcp.json)). Jak agenci mają z niej
korzystać (proaktywne `search_memory`, human-gated `save_memory`, higiena zapisów) opisuje
[`AGENTS.md`](AGENTS.md) — Claude Code zaciąga go przez [`CLAUDE.md`](CLAUDE.md) (`@AGENTS.md`).

Żeby włączyć pamięć na swojej maszynie: `.mcp.json` jedzie z repo, ale token trzymasz lokalnie w
zmiennej środowiskowej `CONTEXT_KEEPER_TOKEN` (nie ma go w repo):

```powershell
setx CONTEXT_KEEPER_TOKEN "ck_...twoj_klucz_z_dashboardu..."   # Windows (user env)
```

```bash
export CONTEXT_KEEPER_TOKEN=ck_...                             # Linux/macOS: profil powłoki
```

Potem zrestartuj terminal i klienta MCP oraz zaakceptuj serwer `context-keeper` przy pierwszym
uruchomieniu. Health jest publiczny (bez tokenu):

```bash
curl https://ck-mcp.dgolczewski.pl/health    # -> {"status":"ok","db":"up","embeddings":"up"}
```

## Gdzie co jest

```
apps/server/     NestJS host — MCP + JSON API + bundle SPA (config, db, projects, cli w src/)
apps/dashboard/  SPA recenzenta (bundlowana do serwera)
infra/           Caddyfile (tryb A), nginx.conf.example (BYO proxy), backup.sh, restore.sh
deploy/          warianty compose pod Coolify (PaaS)
context/         specyfikacja (PRD, tech-stack, design system, roadmap)
docs/            runbooki: deploy (Coolify), backup/restore
install.sh       instalator onboardingu (POSIX sh)
```

Skrypty root (`pnpm dev` / `build` / `lint` / `test` / `cli` / `db:generate` / `db:migrate`) —
patrz `package.json`.

## Bezpieczeństwo

- Bearer token `ck_` (256-bit); w bazie tylko **SHA-256** (`token_hash`), nigdy plaintext.
- `.env` poza repo; sekrety nie trafiają do obrazu.

## Operacje

- **Deploy (Coolify):** [`docs/deploy-coolify.md`](docs/deploy-coolify.md) · [`docs/deploy-coolify-nginx.md`](docs/deploy-coolify-nginx.md)
- **Backup / Restore (NFR-5):** [`docs/backup-restore.md`](docs/backup-restore.md) — `infra/backup.sh` (`pg_dump -Fc` + retencja tiered + opcjonalny offsite), `infra/restore.sh` (restore do scratch DB, promocja do prod ręczna).
