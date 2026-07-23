# Deploy na Coolify

Runbook do wdrożenia Context Keepera na [Coolify](https://coolify.io/) z buildem **z repo**
(nie z GHCR) przez `docker-compose.coolify.yml`. Uzupełnienie do `README.md` (ścieżki
instalator/Docker-manualnie/dev), nie zamiennik — kanon configu wciąż jest w `.env.example`.

## 1. Utworzenie zasobu w Coolify

1. **New Resource → Docker Compose** (nie "Application" — potrzebujemy dwóch serwisów: `db` + `app`).
2. Wskaż repo Context Keepera i branch do deployu.
3. **Base Directory**: root repo. **Docker Compose Location**: `docker-compose.coolify.yml`
   (NIE domyślny `docker-compose.yml` — ten drugi ma `ports:`/profile `edge-proxy` myślane pod
   bring-your-own-proxy, nie pod Coolify).
4. Coolify zbuduje obraz `app` z `apps/server/Dockerfile` (kontekst = root repo, tak jak w
   Compose) — pierwszy build może potrwać kilka minut (dashboard SPA + server w jednym multi-stage).

## 2. Dwie domeny — MCP publiczny, dashboard admin

`docker-compose.coolify.yml` wystawia **jeden proces** (`app`) na **dwóch portach** — to bezpośrednie
odzwierciedlenie `createSurfaceMiddleware` (`apps/server/src/dashboard/surface.middleware.ts`):
port `3000` (`PORT_MCP`) to allowlista TYLKO `/mcp*` + `/health*`, port `3001` (`PORT_DASHBOARD`)
to reszta (SPA, `/api/*`) z odrzuconym `/mcp*`. Coolify musi więc dostać **dwie osobne domeny**,
po jednej na port, żeby ten rozdział miał sens na poziomie sieci, nie tylko w kodzie appki:

| Zmienna (magic-env Coolify) | Port | Powierzchnia | Widoczność |
|---|---|---|---|
| `SERVICE_FQDN_APP_3000` | 3000 | `/mcp*`, `/health*` | **publiczna** (to jest cel produktu — agenci łączą się tu) |
| `SERVICE_FQDN_APP_3001` | 3001 | SPA dashboard + `/api/*` | **admin — patrz sekcja Bezpieczeństwo niżej, NIE zostawiaj gołej** |

W Coolify UI: zakładka zasobu → **Domains**, ustaw po jednej domenie/subdomenie dla każdego z
portów 3000/3001 serwisu `app`. Coolify sam wstrzyknie `SERVICE_FQDN_APP_3000`/`_3001` do środowiska
kontenera na bazie tych ustawień (magic-env) — nie trzeba ich wpisywać ręcznie jako zwykłe env vars.

> **Open question (dokumentacyjne, nie blokuje):** dokładna forma pól do wypełnienia w UI
> ("Domains" per port vs. per serwis vs. ręczny wpis `SERVICE_FQDN_APP_<port>` jako zmienna) bywa
> inna między wersjami Coolify. `docker-compose.coolify.yml` używa formy mapowej
> (`SERVICE_FQDN_APP_3000: ${SERVICE_FQDN_APP_3000}`) zgodnej z dokumentacją Coolify na dzień
> pisania tego runbooka — **potwierdź na swojej instancji Coolify** (wersja UI), że pola faktycznie
> tak się nazywają i tak trafiają do kontenera; jeśli nie, dostosuj tę linię w compose do właściwej
> konwencji swojej wersji.

## 3. Zmienne środowiskowe

Ustaw w Coolify UI (zasób → **Environment Variables**). Wartości bez defaultu w compose = **musisz**
je ustawić w UI, inaczej `envSchema` (Faza 1) odrzuci start appki albo Postgres wystartuje z pustym
hasłem.

### Sekrety (wymagane, bez defaultu)

| Zmienna | Rola |
|---|---|
| `POSTGRES_PASSWORD` | hasło do Postgresa (serwis `db` + `DATABASE_URL` składany w `app`) |
| `SESSION_SECRET` | podpis cookie sesji dashboardu (wymagany w produkcji, `envSchema` to wymusza) |
| `DASHBOARD_PASSWORD` | seed hasła dashboardu (wymagany w produkcji) |
| `EMBEDDING_API_KEY` | klucz do zewnętrznego API embeddingów (`EMBEDDING_PROVIDER=api`) |
| `EMBEDDING_API_URL` | endpoint API embeddingów, np. `https://api.openai.com/v1/embeddings` |

### Skonfigurowalne (mają default w compose, nadpisz w razie potrzeby)

| Zmienna | Default w `docker-compose.coolify.yml` | Rola |
|---|---|---|
| `POSTGRES_USER` | `ck` | user Postgresa |
| `POSTGRES_DB` | `context_keeper` | nazwa bazy |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | model u providera API |

Compose na sztywno ustawia `EMBEDDING_PROVIDER=api` i `EMBEDDING_DIM=1024` (skrócone przez
Matryoshka/`dimensions` z natywnych 1536 — patrz `apps/server/src/embeddings/api.provider.ts`) —
kolumna wektorowa jest fizycznie `vector(1024)`, więc to jedyna poprawna wartość dla tego presetu;
nie nadpisuj `EMBEDDING_DIM` w UI.

## 4. Migracje — automatyczne, nic do zrobienia ręcznie

`DB_AUTO_MIGRATE=true` (ustawione w compose) sprawia, że `app` migruje bazę **in-process, przed
otwarciem nasłuchu** (`apps/server/src/main.ts`, `runMigrations` z `db/migrate.ts`), zabezpieczone
blokującym `pg_advisory_lock` (klucz `MIGRATION_LOCK_KEY`, odrębny od locka nocnego joba) — przy
rollowanym redeployu z wieloma replikami boot-y się serializują (czekają na siebie), nie ścigają.
Błąd migracji = appka nie wstaje (fail-fast, zobaczysz to w logach Coolify i w statusie deploya) —
**nie** wystartuje na wpół-zmigrowanej bazie. Nie ma osobnego serwisu `migrate` w tym compose —
w przeciwieństwie do `docker-compose.yml` (dev/VPS), gdzie migrację odpala się jako osobny
`docker compose run --rm app node dist/db/migrate.js`.

## 5. Nightly job + backup — Coolify Scheduled Tasks zamiast host-crona

Na VPS/`install.sh` `NIGHTLY_CRON`/`BACKUP_CRON` to kontrakt dla crontaba na hoście (patrz README).
Na Coolify nie masz (zwykle) dostępu do hosta — zamiennik to **Coolify → zasób → Scheduled Tasks**:

- **Nightly** (dedup/merge/prune proposer): komenda w kontenerze `app`, odpowiednik
  `node dist/cli.js run-nightly` (harmonogram wg `NIGHTLY_CRON`/`NIGHTLY_TZ`, które appka i tak
  tylko dokumentuje, nie czyta — Ty ustawiasz harmonogram w UI Coolify).
- **Backup**: `infra/backup.sh` robi `pg_dump` **wewnątrz kontenera `db`**
  (`docker compose exec -T db ...`) — w środowisku Coolify to prawdopodobnie musi zostać uruchomione
  jako task na hoście/w kontenerze z dostępem do Docker socketa, albo przepisane na wariant, który
  łączy się do `db` bezpośrednio po sieci (`pg_dump` z hosta/innego kontenera przez `DATABASE_URL`).
  `record-backup` (`node dist/cli.js record-backup --status ok|failed ...`) zapisuje wynik do
  audit logu niezależnie od tego, skąd backup faktycznie wystartował.

> **Open question (dokumentacyjne, nie blokuje):** dokładny kontekst wykonania Coolify Scheduled
> Tasks (czy komenda leci `exec` do już-działającego kontenera `app`/`db`, czy w nowym efemerycznym
> kontenerze z tego samego obrazu, i czy ten kontekst w ogóle ma dostęp do Docker socketa
> potrzebnego przez `infra/backup.sh`) jest wersyjny/planowo-zależny w Coolify — **potwierdź na
> swojej instancji** przed poleganiem na tym mechanizmie produkcyjnie. Do czasu potwierdzenia,
> traktuj to jako rekomendowany kierunek, nie gotowy przepis "wklej i zapomnij".

## 6. Bezpieczeństwo — dashboard 3001 MUSI być za kontrolą dostępu (decyzja zamknięta)

**To jest krok obowiązkowy, nie opcjonalny.** Oryginalny design (Faza 5, `infra/Caddyfile`) zakłada,
że powierzchnia dashboardu (SPA + `/api/*`, port `PORT_DASHBOARD`/3001) siedzi **za VPN albo
Cloudflare Access** — tylko `/mcp*`+`/health*` (port 3000) miały być gołym publicznym internetem.
Coolify per default wystawi każdą domenę, którą mu podasz, publicznie na 80/443 — samo dodanie
`SERVICE_FQDN_APP_3001` bez dodatkowej ochrony **łamie ten model zagrożeń**: `DASHBOARD_PASSWORD` +
sesja (cookie) to warstwa aplikacyjna, zaprojektowana jako drugi czynnik NA WIERZCHU sieciowej
izolacji, nie jako jedyna linia obrony samodzielnie.

Dlatego domena podpięta pod `SERVICE_FQDN_APP_3001` **musi** zostać obudowana jednym z (Coolify,
zależnie od planu/wersji instancji):

- **IP-allowlist** na poziomie reverse-proxy Coolify (Traefik/Caddy) dla tej konkretnej domeny, albo
- **SSO / access control** (np. Cloudflare Access przed domeną, albo wbudowany middleware Coolify,
  jeśli dostępny na Twojej instancji).

Domena podpięta pod `SERVICE_FQDN_APP_3000` (`/mcp*` + `/health*`) **zostaje publiczna** — to
zamierzone, to jest cel produktu (agenci MCP muszą się tu dobić bez VPN).

> **Open question (dokumentacyjne, nie blokuje):** który dokładnie mechanizm (IP-allowlist vs SSO)
> i jego dokładna konfiguracja w UI jest zależna od wersji/planu Twojej instancji Coolify —
> **potwierdź i skonfiguruj na swojej instancji** przed wystawieniem 3001 do internetu. Nie
> traktuj samego `DASHBOARD_PASSWORD` jako wystarczającego zabezpieczenia w tym trybie.

## 7. Weryfikacja po deployu

```bash
# 1. MCP + health (domena SERVICE_FQDN_APP_3000) — publiczne, powinny odpowiadać:
curl https://<domena-3000>/health         # -> {"status":"ok","db":"up"}

# 2. Rozdział powierzchni — /mcp NIE powinien odpowiadać na domenie dashboardu (3001):
curl -i https://<domena-3001>/mcp         # -> 404 (surface.middleware odrzuca /mcp* na porcie dashboardu)

# 3. Postgres nieosiągalny z zewnątrz — `db` używa `expose:`, nie `ports:`, więc port 5432
#    NIE powinien być routowalny spoza sieci dockerowej Coolify:
curl -m 3 telnet://<host-coolify>:5432    # -> connection refused/timeout (nie ma publikacji portu)
```

Sprawdź też logi deploya w Coolify — powinieneś zobaczyć `[migrate] applying migrations from ...`
i `[migrate] done` PRZED linią `Context Keeper listening on :3000 (mcp) i :3001 (dashboard)`
(fail-fast: appka nie loguje "listening" jeśli migracja padnie).

## 8. Różnice vs pozostałe ścieżki deployu

| | `docker-compose.yml` (VPS/`install.sh`) | `docker-compose.coolify.yml` (ten runbook) |
|---|---|---|
| Reverse proxy | opcjonalny bundled Caddy (profil `edge-proxy`) albo bring-your-own | Coolify (Traefik/Caddy wbudowany) |
| Ekspozycja portów | `ports:` (publikacja na hosta) | `expose:` (tylko sieć dockerowa Coolify) |
| `TRUST_PROXY` | `false` (default) albo `true` wg trybu | zawsze `true` (Coolify zawsze terminuje TLS upstream) |
| Domeny | 1 origin (opcjonalnie za Caddym) | 2 domeny (`SERVICE_FQDN_APP_3000`/`_3001`) |
| Embeddingi | `local` (default, sidecar TEI) albo `api` | `api` (na sztywno w compose — brak sidecara TEI) |
| Migracje | `DB_AUTO_MIGRATE=true` (default) albo manualny `db:migrate` | zawsze auto (`DB_AUTO_MIGRATE=true`, brak serwisu `migrate`) |
| Nightly/backup scheduling | host crontab (`install.sh` generuje) | Coolify Scheduled Tasks (§5 wyżej) |
