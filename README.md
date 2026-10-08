# Context Keeper

Współdzielona, trwała, **human-gated** pamięć dla agentów AI, wystawiona jako remote MCP server.

Agenci (Claude Code, Codex, Cursor…) zaczynają każdą sesję od zera i gubią decyzje, konwencje oraz
„dlaczego tak" projektu. Context Keeper daje im **wspólną pamięć**: agenci **szukają** w niej
kontekstu i **proponują** zapisy — ale nic nie trafia do pamięci bez zatwierdzenia przez człowieka.

Specyfikacja: [`context/prd.md`](context/prd.md) · [`context/tech-stack.md`](context/tech-stack.md) · [`context/design-system.md`](context/design-system.md) · [`context/roadmap.md`](context/roadmap.md)

> **Status:** v1.6 (auto mode i nadzór nad skalą) domknięte, dogfooding live. Następne:
> v1.7 (proces i jakość) — patrz [`context/roadmap.md`](context/roadmap.md).

## Najważniejsze funkcje

- **Human-gate** — każdy zapis (agenta i nocnego joba) ląduje w kolejce akceptacji; do pamięci
  trafia dopiero po zatwierdzeniu przez człowieka. To główna obrona przed memory-poisoning, nie tylko proces.
- **Remote MCP** — narzędzia pamięci `search_memory` / `get_memory` / `save_memory`; podłączasz
  dowolnego klienta MCP przez `.mcp.json` + bearer token. Jeden **token konta** obsługuje wszystkie
  repo (projekt wskazuje nagłówek `X-Context-Keeper-Project`), a z nim agent dostaje też
  `list_projects` / `create_project` i prompt `onboard` do podpięcia nowego repo.
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

Konkretne wersje i uzasadnienia: [`context/tech-stack.md`](context/tech-stack.md).

## Wymagania

- **Docker + Compose** — każda ścieżka instalacji.
- **POSIX `sh` + `openssl`** — tylko instalator. Na Windows uruchom go z Git Bash albo WSL.
- **Node ≥ 22 + pnpm 10** — tylko dev na hoście.

```bash
git clone https://github.com/Grog99/context-keeper.git
cd context-keeper
```

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

Po instalacji dashboard jest pod `http://localhost:3001` (w trybie `edge-proxy`: `https://<ACME_DOMAIN>`).
Hasło to `DASHBOARD_PASSWORD` z wygenerowanego `.env` — instalator go nie wypisuje. Instalator wydaje
**token projektowy** pierwszego projektu; token konta (jeden na wiele repo) wydasz w dashboardzie albo
CLI `create-account-token`. Dalej: [Podłącz swojego agenta](#podłącz-swojego-agenta).

## Szybki start — Docker, manualnie (fallback / zaawansowany)

```bash
cp .env.example .env          # dostosuj sekrety (SESSION_SECRET, DASHBOARD_PASSWORD, opcjonalnie SECRETS_ENCRYPTION_KEY)
docker compose up -d db       # Postgres + pgvector
docker compose --profile local-embeddings up -d embeddings   # sidecar embeddingów (TEI + bge-m3)
docker compose up -d app      # serwer — auto-migruje przy starcie (DB_AUTO_MIGRATE=true, domyślnie)
curl localhost:3000/health    # -> {"status":"ok","db":"up","embeddings":"up"}

# Pierwszy projekt + bearer token (token pokazywany RAZ):
docker compose run --rm app node dist/cli.js create-project acme
```

Dashboard: `http://localhost:3001`, logowanie hasłem `DASHBOARD_PASSWORD` z `.env`.

> **Embeddingi:** `.env.example` ma domyślnie `EMBEDDING_PROVIDER=local`, czyli oczekuje sidecara
> `embeddings` (pierwszy start pobiera model, ok. 2 GB). Dopóki sidecar nie wstanie — albo gdy go
> nie uruchomisz — app działa dalej, ale `/health` zwraca `"status":"degraded"`, a wyszukiwanie
> jest tylko pełnotekstowe (FTS). Zamiast sidecara możesz użyć zewnętrznego API
> (`EMBEDDING_PROVIDER=api`, opis w `.env.example`).

> Domyślnie `app` migruje bazę in-process przed nasłuchem — nie musisz odpalać osobnego kroku.
> Przy `DB_AUTO_MIGRATE=false` migrujesz sam PRZED startem appki:
> `docker compose run --rm app node dist/db/migrate.js`.
>
> Migracje bywają nieodwracalne (np. `0010` usuwa kolumny tokena z `projects` po przejściu na
> model wielotokenowy) — deploy musi być **stop-then-start**, nie rolling/blue-green z dwiema
> wersjami appki działającymi jednocześnie na tej samej bazie.

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
pnpm dev                      # serwer z watch: MCP na :3000, API dashboardu na :3001

# w drugim terminalu — dashboard (Vite z HMR, proxy /api -> :3001):
pnpm --filter @context-keeper/dashboard dev           # http://localhost:5173

pnpm --filter @context-keeper/server cli:dev create-project acme
```

W dev serwer nie serwuje zbudowanego dashboardu (`localhost:3001/` zwraca 404) — SPA idzie z Vite.
Sidecar embeddingów nie jest wystawiony na host, więc wyszukiwanie działa tylko pełnotekstowo
(`/health` → `degraded`); do developmentu to wystarcza.

## Podłącz swojego agenta

Po instalacji podpinasz dowolne repo (Claude Code, Codex, Cursor…) pod swoją instancję. Są dwie ścieżki.

### Token konta + nagłówek (domyślnie, wiele repo)

Jeden token na maszynie, a każde repo wskazuje swój projekt **nagłówkiem** w commitowanym `.mcp.json` —
nowe repo to jeden plik, bez nowego tokena i bez przestawiania zmiennych.

1. **Token konta** — dashboard → *Projekty* → *Tokeny konta* → *Nowy token* (albo CLI:
   `create-account-token <label>`). Token `ck_` jest pokazywany **raz** — zapisz go od razu.
2. **Zmienna środowiskowa, raz globalnie** — `CONTEXT_KEEPER_TOKEN` (`setx` na Windows, `export`
   w profilu powłoki). Token nigdy nie trafia do repo.
3. **Per repo** — dashboard → *Onboarding* → wybierz projekt → skopiuj `.mcp.json` (z nagłówkiem
   `X-Context-Keeper-Project`) oraz bloki `AGENTS.md` / `CLAUDE.md` (`@AGENTS.md` dla Claude Code,
   który nie czyta `AGENTS.md` sam). Adres w `.mcp.json` pochodzi z `PUBLIC_MCP_URL` w `.env` serwera
   (lokalnie `http://localhost:3000`) — bez niego zobaczysz placeholder do ręcznej podmiany. Albo zleć to
   agentowi: z tokenem konta ma narzędzia `list_projects` i `create_project` (to drugie tworzy
   *propozycję* projektu — zatwierdzasz ją w *Kolejce*).
4. **Opcjonalnie, tylko Claude Code** — wpis na poziomie użytkownika, żeby agent w jeszcze
   nieskonfigurowanym repo dosięgnął `list_projects` / `create_project`:
   `claude mcp add --transport http --scope user context-keeper <adres>/mcp --header "Authorization: Bearer <ck_…>"`.
   Nazwa serwera musi być dokładnie `context-keeper`, a token ląduje w `~/.claude.json` jako zwykły tekst.
   Potem w nowym repo wpisz `/context-keeper:onboard` (alias `/mcp__context-keeper__onboard`) — agent dobierze projekt przez `list_projects` / `create_project`, scali `.mcp.json` i dopisze bloki `AGENTS.md` / `CLAUDE.md`, pokazując diff przed zapisem.
5. Zrestartuj terminal i klienta MCP, a przy pierwszym uruchomieniu zaakceptuj serwer
   `context-keeper`.

> **Precedencja wpisów MCP w Claude Code:** `.mcp.json` repo zastępuje wpis użytkownika o tej samej
> nazwie **w całości** (pola nie są scalane), a wpis zakresu lokalnego przesłania oba — szczegóły:
> [dokumentacja Claude Code](https://code.claude.com/docs/en/mcp).

### Token projektowy (CI / współpracownik / pojedyncze repo)

Token związany z jednym projektem — projekt wynika z tokena, więc `.mcp.json` **bez** nagłówka.
Wydasz go przy tworzeniu projektu (*Projekty* → *Nowy projekt* albo CLI `create-project <nazwa> [--slug <slug>]`)
lub w *Projekty* → *Tokeny*; blok `.mcp.json` jest w *Onboarding* → „Token projektowy". Zmienna ta sama: `CONTEXT_KEEPER_TOKEN`.
Istniejące repo z takim `.mcp.json` działają bez zmian.

Od tej chwili agent szuka w pamięci i proponuje zapisy — każda propozycja czeka w dashboardzie
(*Kolejka*) na Twoją akceptację.

## Pamięć projektu (dogfooding)

Dotyczy pracy nad **tym** repo. Repo używa **własnej wdrożonej instancji** jako trwałej pamięci projektu, wystawionej jako serwer
MCP `context-keeper` (config w commitowanym [`.mcp.json`](.mcp.json)). Jak agenci mają z niej
korzystać (proaktywne `search_memory`, human-gated `save_memory`, higiena zapisów) opisuje
[`AGENTS.md`](AGENTS.md) — Claude Code zaciąga go przez [`CLAUDE.md`](CLAUDE.md) (`@AGENTS.md`).

Żeby włączyć pamięć na swojej maszynie: `.mcp.json` jedzie z repo i wskazuje projekt nagłówkiem
`X-Context-Keeper-Project: context-keeper`, a adres instancji i token trzymasz lokalnie w zmiennych
środowiskowych (nie ma ich w repo):

- `CONTEXT_KEEPER_URL` — bazowy adres Twojej instancji, bez `/mcp` (domyślnie
  `http://localhost:3000`, czyli lokalny `docker compose` / `pnpm dev`),
- `CONTEXT_KEEPER_TOKEN` — **token konta** z dashboardu (*Projekty* → *Tokeny konta*). Token
  projektowy projektu o slugu `context-keeper` też zadziała — nagłówek wskazuje jego własny projekt.

Na Twojej instancji musi istnieć projekt o slugu `context-keeper` (slug ustawisz w *Projekty*).

```powershell
setx CONTEXT_KEEPER_URL "https://twoja-instancja.example.com"   # Windows (user env)
setx CONTEXT_KEEPER_TOKEN "ck_...twoj_klucz_z_dashboardu..."
```

```bash
export CONTEXT_KEEPER_URL=https://twoja-instancja.example.com   # Linux/macOS: profil powłoki
export CONTEXT_KEEPER_TOKEN=ck_...
```

Potem zrestartuj terminal i klienta MCP oraz zaakceptuj serwer `context-keeper` przy pierwszym
uruchomieniu. Health jest publiczny (bez tokenu):

```bash
curl "$CONTEXT_KEEPER_URL/health"    # -> {"status":"ok","db":"up","embeddings":"up"}
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

- Bearer token `ck_` (256-bit); w bazie tylko **SHA-256** (`project_tokens.token_hash`), nigdy plaintext.
- **Token konta daje pełny odczyt i zapis we wszystkich projektach instancji** (także propozycje do
  kolejki i zakładanie projektów) — jego wyciek jest groźniejszy niż wyciek tokena projektowego. Dla CI
  i współpracowników używaj tokenów projektowych.
- Wiele tokenów per projekt (jeden na agenta, etykieta wymagana) — rotacja **graceful** (nowy token
  obok starego, stary wygasa po okresie karencji, `TOKEN_GRACE_PERIOD_HOURS`) albo **unieważnienie
  natychmiastowe** dla skompromitowanych danych; CLI: `list-tokens` / `create-token` / `rotate-token`
  / `revoke-token`, a dla tokenów konta `create-account-token` / `list-account-tokens`
  (`rotate-token` i `revoke-token` działają dla obu rodzajów).
- `.env` poza repo; sekrety nie trafiają do obrazu.
- Klucz API modelu LLM (opcjonalny krok nocnego joba, ustawiany w dashboardzie → Ustawienia) leży w bazie
  **wyłącznie zaszyfrowany** (AES-256-GCM, klucz z env `SECRETS_ENCRYPTION_KEY`; `install.sh` generuje go raz),
  a REST nigdy go nie zwraca. Sprawdzenie konfiguracji: CLI `check-llm` (jedno testowe wywołanie, bez klucza w
  wyjściu). Po włączeniu kroku treść pamięci wychodzi do wskazanego endpointu — domyślnie jest wyłączony.

## Operacje

- **Deploy (Coolify):** [`docs/deploy-coolify.md`](docs/deploy-coolify.md) · [`docs/deploy-coolify-nginx.md`](docs/deploy-coolify-nginx.md)
- **Backup / Restore (NFR-5):** [`docs/backup-restore.md`](docs/backup-restore.md) — `infra/backup.sh` (`pg_dump -Fc` + retencja tiered + opcjonalny offsite), `infra/restore.sh` (restore do scratch DB, promocja do prod ręczna).

## Licencja

[MIT](LICENSE) © 2026 Daniel Golczewski
