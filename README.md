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

## Szybki start — instalator (zalecane)

```bash
./install.sh
```

`install.sh` (POSIX `sh`, zależności: `sh` + `openssl`, opcjonalnie `docker` w Fazie 2) to cienki
generator nad `.env` + profilami Compose — **nie zastępuje** `.env.example` (kanon configu), tylko
go templatuje. Dwie fazy:

1. **Faza 1 (zawsze, offline)** — kilka pytań (tryb edge A/bundled-Caddy vs B/bring-your-own-proxy,
   preset embeddingów, harmonogram nocnego joba, nazwa pierwszego projektu), bezpieczne
   generowanie/zachowanie `SESSION_SECRET`/`DASHBOARD_PASSWORD` (re-run nigdy nie unieważnia cichej
   sesji), atomowy zapis `.env` (`umask 077`, mode `600`).
2. **Faza 2 (opcjonalna, prompt; domyślnie tylko generacja)** — `docker compose up -d`, migracje,
   `create-project` przez Nest CLI (token wypisywany **raz** — instalator go nie przechwytuje).

Flagi: `-y`/`--yes` (bez promptów, wartości domyślne), `--start`/`--no-start` (wymuś decyzję Fazy 2),
`--dry-run` (wypisz `.env` na stdout, nic nie zapisuj na dysk — sekrety nigdy nie są drukowane, nawet
w `--dry-run`), `-h`/`--help`. Prompty/komunikaty skryptu są po angielsku (szerszy zasięg operatorów).
Idempotentny: ponowne uruchomienie z istniejącym `.env` pyta zachować/regenerować/przerwać, nigdy nie
nadpisuje cicho, a wybór presetu embeddingów zmieniającego `EMBEDDING_DIM` pod istniejącymi danymi
jest blokowany ostrzeżeniem (wskazuje na CLI `reembed`).

## Szybki start — Docker, manualnie (fallback / zaawansowany)

```bash
cp .env.example .env          # dostosuj sekrety (SESSION_SECRET, DASHBOARD_PASSWORD)
docker compose up -d db       # Postgres + pgvector
docker compose up -d app      # serwer — auto-migruje przy starcie (DB_AUTO_MIGRATE=true, domyślnie)
curl localhost:3000/health    # -> {"status":"ok","db":"up"}

# Pierwszy projekt + bearer token (token pokazywany RAZ):
docker compose run --rm app node dist/cli.js create-project acme
```

> Domyślnie (`DB_AUTO_MIGRATE=true`) `app` sam migruje bazę **in-process, przed nasłuchem** —
> nie musisz odpalać osobnego kroku migracji, krok wyżej to celowo pominięty (skippable) case.
> Jeśli ustawisz `DB_AUTO_MIGRATE=false` (migrujesz sam, np. chcesz kontrolować moment migracji
> niezależnie od restartu appki), odpal migrację ręcznie PRZED `docker compose up -d app`:
>
> ```bash
> docker compose run --rm app node dist/db/migrate.js   # migracje (schema + pgvector + FTS/HNSW)
> ```

> W kontenerze uruchamiamy `node dist/...` bezpośrednio — bez pośredniczącego procesu pnpm.
> Skrót `pnpm cli <cmd>` też działa w kontenerze (woła to samo `dist/cli.js`), `node dist/cli.js` jest po prostu bardziej bezpośredni.

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

Potem zrestartuj terminal i klienta MCP (np. Claude Code — żeby wczytał zmienną i `.mcp.json`) oraz
zaakceptuj serwer `context-keeper` przy pierwszym uruchomieniu. Health jest publiczny (bez tokenu),
więc endpoint zweryfikujesz od razu:

```bash
curl https://ck-mcp.dgolczewski.pl/health    # -> {"status":"ok","db":"up","embeddings":"up"}
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
install.sh              instalator onboardingu (POSIX sh) — generuje .env, opcjonalnie startuje stack
apps/server/           NestJS host (MCP + JSON API + bundle SPA)
  src/config/          zod env (12-factor)
  src/db/              Drizzle schema + migracje + runner
  src/projects/        projekty, generacja/hash tokenów ck_, BearerGuard
  src/health/          /health
  src/cli/             komendy nest-commander
infra/Caddyfile        bundled edge (tryb A)
infra/nginx.conf.example  przykład reverse proxy nginx (bring-your-own-proxy / Pangolin)
infra/backup.sh         pg_dump + retencja tiered + offsite (NFR-5, patrz "Backup / Restore")
infra/restore.sh        restore dumpa do scratch DB + runbook promocji
deploy/                warianty compose pod Coolify (PaaS, build z repo):
  docker-compose.coolify.yml        pod wbudowany proxy Coolify — docs/deploy-coolify.md
  docker-compose.coolify-nginx.yml  za własnym nginx + Pangolin — docs/deploy-coolify-nginx.md
docs/deploy-coolify.md  runbook: Coolify (wbudowany proxy)
docs/deploy-coolify-nginx.md  runbook: Coolify za nginx + Pangolin
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
