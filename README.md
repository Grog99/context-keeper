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
infra/backup.sh         pg_dump + retencja tiered + offsite (NFR-5, patrz "Backup / Restore")
infra/restore.sh        restore dumpa do scratch DB + runbook promocji
context/               specyfikacja (PRD, tech-stack, design system, roadmap)
```

## Bezpieczeństwo (Fundament)

- Bearer token `ck_` + 256-bit; w bazie tylko **SHA-256** (`token_hash`), nigdy plaintext.
- `.env` poza repo; sekrety nie trafiają do obrazu.

## Backup / Restore (NFR-5, Faza 7)

`pg_dump`/`pg_restore` odpalane WEWNĄTRZ kontenera `db` (`docker compose exec -T db …`) — zgodność
wersji klient/serwer za darmo, działa nawet gdy obraz `app` jest zepsuty/niezbudowany. Format
dumpa: `-Fc` (custom, skompresowany). Auto-scheduling (crontab) to **Faza 8** — na razie skrypty
uruchamia się ręcznie albo z zewnętrznego schedulera skonfigurowanego wg `BACKUP_CRON`/`BACKUP_TZ`
poniżej (appka tych zmiennych nie czyta, to sam kontrakt — jak `NIGHTLY_CRON`/`NIGHTLY_TZ`).

### Backup ręczny

```bash
infra/backup.sh
```

Robi po kolei: `pg_dump -Fc` do pliku tymczasowego → atomowy `mv` na `BACKUP_DIR/ck-<UTC-ISO-stamp>.dump`
(mode 600) → retencję tiered (patrz niżej) → opcjonalny offsite. Kończy jedną linią podsumowania,
np. `[backup] status=ok dump=./backups/ck-20260722T030000Z.dump size=1048576 offsite=rclone:...`.

Zmienne (`.env`, patrz `.env.example` po pełne komentarze):

| Zmienna | Domyślnie | Rola |
|---|---|---|
| `BACKUP_DIR` | `./backups` | gdzie lądują dumpy (host bind, nie wolumen Dockera — patrz `.gitignore`) |
| `BACKUP_RETENTION_DAILY_DAYS` | `7` | ile dni wstecz zachować WSZYSTKIE dumpy |
| `BACKUP_RETENTION_WEEKLY_WEEKS` | `4` | ile dodatkowych tygodni ISO zachować po jednym (najnowszym) dumpie; `0` = wyłącz weekly tier |
| `BACKUP_CRON` / `BACKUP_TZ` | `0 4 * * *` / `Europe/Warsaw` | kontrakt dla schedulera z Fazy 8 (godzinę po `NIGHTLY_CRON`, bez nakładania) |
| `RCLONE_REMOTE` | *(puste)* | opcjonalny cel `rclone copy` (patrz niżej) |
| `BACKUP_OFFSITE_CMD` | *(puste)* | opcjonalna własna komenda offsite (patrz niżej) |

### Retencja — tiered 7 daily + 4 weekly

Zamiast płaskiego "usuń starsze niż N dni":

- **Daily tier** — dumpy młodsze niż `BACKUP_RETENTION_DAILY_DAYS` dni: zachowane **wszystkie**
  (gęste RPO na ostatni tydzień).
- **Weekly tier** — dumpy w oknie `[DAILY_DAYS, DAILY_DAYS + WEEKLY_WEEKS*7)` dni: zachowany
  **dokładnie jeden, najnowszy dump na tydzień ISO** (`date +%G-%V`), reszta z tego tygodnia skasowana.
- **Ancient** — dumpy starsze niż wyprowadzony cutoff (`DAILY_DAYS + WEEKLY_WEEKS*7`, domyślnie
  `7 + 4*7 = 35` dni): skasowane.

Klucz wieku/tygodnia to **znacznik UTC z nazwy pliku** (`ck-YYYYMMDDThhmmssZ.dump`), nie `mtime` —
odporne na `cp`/round-trip przez offsite/`touch`/restore z kopii. Brak dnia/tygodnia (cron nie
odpalił się, skrypt padł) tylko zmniejsza retencję dla tego okresu — nie kasuje sąsiednich
tygodni i nie wywala skryptu. Nazwy nieparsowalne są pomijane, nie kasowane. Retencja liczy się
TYLKO po udanym nowym dumpie (nigdy przy błędzie `pg_dump`).

### Offsite (pluggable hook)

Lokalny dump + retencja działają bez żadnej zależności zewnętrznej; offsite jest **opcjonalny i
podłączalny** — dwie ścieżki, `BACKUP_OFFSITE_CMD` ma pierwszeństwo gdy oba ustawione:

**Opcja A — rclone (rekomendowana):** jeden statyczny binary, 70+ backendów (S3, B2, GCS, SFTP…).

```bash
rclone config                                   # jednorazowo, nazwij remote np. "ck-offsite"
# .env:
RCLONE_REMOTE=ck-offsite:context-keeper-backups
```

**Opcja B — własna komenda:** `BACKUP_OFFSITE_CMD` wołane jako `sh -c "$BACKUP_OFFSITE_CMD" sh "$1"`
— `"$1"` w komendzie to ścieżka do świeżego dumpa, np.:

```bash
BACKUP_OFFSITE_CMD=scp "$1" backup-host:/srv/ck-backups/
```

Fail offsite (dowolna z dwóch ścieżek) → **głośny `exit 1`** pod cronem/monitoringiem, ale lokalny
dump ZOSTAJE (retencja go nie kasuje z powodu offsite failure). Jeśli offsite jest niedostępny
dłużej niż efektywny cutoff retencji (domyślnie 35 dni), lokalna retencja może wyciąć ostatnie
kopie mimo braku kopii offsite — monitoruj exit code `infra/backup.sh`.

### Restore — runbook

„Backup, którego nikt nie restore'ował, nie jest backupem." `infra/restore.sh` **nigdy nie dotyka
bazy produkcyjnej domyślnie** — odtwarza do dedykowanej bazy scratch, promocja do prod to osobny,
manualny krok.

```bash
# 1. Backup (albo użyj istniejącego dumpa z BACKUP_DIR)
infra/backup.sh

# 2. Restore do scratch DB (domyślnie context_keeper_restore; --force nadpisuje istniejącą)
infra/restore.sh ./backups/ck-20260722T030000Z.dump
# infra/restore.sh <dump> [target-db] [--force]

# 3. Skrypt sam robi sanity check (count(*) na memories/embeddings/projects + query wektorowe
#    `vector <=> vector` — dowód że rozszerzenie `vector` i HNSW naprawdę się odtworzyły) i
#    wypisuje dokładne komendy promocji do prod (ALTER DATABASE … RENAME TO …).

# 4. Promocja do prod jest RĘCZNA (świadomie — nigdy automatyczna): zatrzymaj `app`, zrób backup
#    bieżącej prod (jeśli jeszcze żyje), zamień nazwy baz, podnieś `app`, sprawdź /health.
```

Uwaga wydajnościowa: `pg_restore` przebudowuje indeks HNSW od zera (wektory są zwykłymi danymi w
dumpie, `CREATE EXTENSION vector` + HNSW są w DDL) — poprawne, ale wolniejsze przy dużej liczbie
wektorów; `pg_restore -j N` (równoległość) skraca to ręcznie, jeśli potrzeba.
