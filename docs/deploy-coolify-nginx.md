# Deploy na Coolify za własnym reverse proxy (host nginx + Pangolin)

Wariant dla setupu, w którym **nie używasz wbudowanego proxy Coolify**, tylko masz na tej samej
maszynie **nginx za [Pangolinem](https://docs.pangolin.net/)**. Coolify tu tylko buduje i uruchamia
kontener; cały ruch publiczny, TLS i auth robią Pangolin + nginx. Wariant pod wbudowany proxy Coolify
opisuje [`deploy-coolify.md`](deploy-coolify.md) — ten dokument jest jego alternatywą, nie zamiennikiem.
Kanon configu wciąż w [`.env.example`](../.env.example).

Compose: [`deploy/docker-compose.coolify-nginx.yml`](../deploy/docker-compose.coolify-nginx.yml).
Przykład nginx: [`infra/nginx.conf.example`](../infra/nginx.conf.example).

## 1. Topologia

```
internet ──TLS──▶ Pangolin/Traefik ──http──▶ host nginx ──http──▶ kontener app
              (TLS + Badger auth      (routing po domenie,     (127.0.0.1:3000 / :3001,
               na dashboardzie)        zachowuje X-Forwarded-*)  trust proxy = true)
```

**Proxy Coolify NIE jest w tej ścieżce.** App publikuje porty tylko na `127.0.0.1` hosta; sięga do
nich host nginx, a przed nim stoi Pangolin. Nikt nie dobije się do app z pominięciem tej ścieżki.

## 2. Zasób w Coolify

1. **New Resource → Docker Compose**, wskaż repo + branch.
2. **Base Directory**: root repo (compose leży w `deploy/`, ale jego `build.context: ..` celuje w root
   monorepo — Base Directory zostaw na root, nie na `deploy/`).
   **Docker Compose Location**: `deploy/docker-compose.coolify-nginx.yml`.
3. **NIE nadawaj domeny** w zakładce *Domains* i **NIE ustawiaj żadnej zmiennej `SERVICE_FQDN_*`.**
   To jest cały trik: Coolify dorzuca router w swoim Traefiku **tylko** gdy nadasz serwisowi domenę
   albo magic-env `SERVICE_FQDN_*`/`SERVICE_URL_*`. Bez nich proxy Coolify ignoruje app, a publikacja
   idzie wyłącznie przez `ports: 127.0.0.1:...` z compose. (Etykiety `coolify.managed=true` które
   Coolify i tak dokłada są nieszkodliwe — to nie router.)
4. Coolify zbuduje obraz `app` z `apps/server/Dockerfile` (pierwszy build kilka minut).

## 3. Zmienne środowiskowe

Te same co w wariancie Coolify — pełna tabela w [`deploy-coolify.md` §3](deploy-coolify.md#3-zmienne-środowiskowe).
Sekrety **wymagane** (bez defaultu w compose, ustaw w Coolify UI): `POSTGRES_PASSWORD`,
`SESSION_SECRET`, `DASHBOARD_PASSWORD`, `EMBEDDING_API_KEY`, `EMBEDDING_API_URL`.
`TRUST_PROXY=true`, `EMBEDDING_PROVIDER=api`, `EMBEDDING_DIM=1024`, `DB_AUTO_MIGRATE=true` są zapięte
w compose — nie musisz ich podawać.

## 4. nginx (host)

Weź [`infra/nginx.conf.example`](../infra/nginx.conf.example) i podmień domeny. Dwa kluczowe punkty:

- **`map $http_x_forwarded_proto $fwd_proto`** — Pangolin/Traefik terminuje TLS i łączy się do nginx
  po zwykłym http. Gdyby nginx wysłał do app `X-Forwarded-Proto: $scheme` (=`http`), aplikacja z
  `trust proxy` uznałaby połączenie za nie-HTTPS, **nie ustawiłaby Secure cookie** i logowanie do
  dashboardu wpadłoby w pętlę. `map` zachowuje wartość `https` przekazaną przez Pangolina.
- **Tuning streamingu MCP** — `proxy_http_version 1.1`, `proxy_buffering off` (dla `text/event-stream`),
  długie `proxy_read_timeout`. Endpoint MCP to Streamable-HTTP; buforowanie łamie strumień.

Dwa `server_name`: `mcp.*` → `127.0.0.1:3000` (publiczny), `app.*` → `127.0.0.1:3001` (admin).
Rozdział odpowiada `createSurfaceMiddleware` w app ([`surface.middleware.ts`](../apps/server/src/dashboard/surface.middleware.ts)):
port 3000 to allowlista `/mcp*`+`/health*`, port 3001 to reszta z odrzuconym `/mcp*`.

## 5. Pangolin

Utwórz **dwa resources**, oba celujące w host nginx (`:80`) — pozwól nginx routować po domenie.
Bo Pangolin, nginx i app są na **tej samej maszynie**, użyj **local site** (target = adres hosta:80);
tunel Newt/WireGuard nie jest potrzebny (przydaje się tylko gdy target jest w innej sieci).

| Resource | Domena | Target | Auth |
|---|---|---|---|
| MCP | `mcp.example.com` | host nginx :80 | **brak** — publiczny (token-gated przez samą appkę) |
| Dashboard | `app.example.com` | host nginx :80 | **Badger SSO / access control WŁĄCZONE** |

Tylko resource dashboardu dostaje auth Pangolina — MCP zostaje publiczny (to cel produktu: agenci
łączą się bez VPN). To czysty rozdział: jedna decyzja auth per domena.

## 6. Weryfikacja po deployu

```bash
# 1. MCP + health (publiczny) — powinny odpowiadać:
curl https://mcp.example.com/health          # -> {"status":"ok","db":"up"}

# 2. Rozdział powierzchni — /mcp NIE odpowiada na domenie dashboardu:
curl -i https://app.example.com/mcp          # -> 404 (surface.middleware odrzuca /mcp* na 3001)

# 3. App NIEosiągalna bezpośrednio, z pominięciem Pangolina/nginx (bind 127.0.0.1):
curl -m 3 http://<publiczne-ip-hosta>:3000/health   # -> connection refused/timeout

# 4. Postgres nieosiągalny z zewnątrz (db bez `ports:`):
curl -m 3 telnet://<publiczne-ip-hosta>:5432        # -> connection refused/timeout
```

**Krok krytyczny — sprawdź, że `X-Forwarded-Proto: https` faktycznie dochodzi do app.**
Zaloguj się do dashboardu (`https://app.example.com`) i potwierdź, że sesja trzyma (Secure cookie się
ustawia). Jeśli logowanie się zapętla lub cookie nie wchodzi — Pangolin/Traefik **nie przekazuje**
`X-Forwarded-Proto` (znany, wersyjny problem Pangolina). Wtedy dodaj do resource'u Pangolina
Traefik `headers` middleware wymuszający `X-Forwarded-Proto: https` (albo `customRequestHeaders`);
`map` w nginx propaguje już poprawną wartość dalej.

W logach deploya Coolify powinieneś zobaczyć `[migrate] applying migrations ...` i `[migrate] done`
PRZED `Context Keeper listening on :3000 (mcp) i :3001 (dashboard)` (auto-migracja, fail-fast).

## 7. Bezpieczeństwo

- **Bind na `127.0.0.1`** (nie `0.0.0.0`) to główna kontrola — app da się dosięgnąć wyłącznie przez
  host nginx, a więc przez Pangolina. `0.0.0.0` wystawiłby app publicznie, omijając auth dashboardu.
- **Postgres bez `ports:`** — tylko sieć dockerowa, `app` łączy się po DNS `db`. Nie publikuj 5432.
- **Ochrona admina jest na Pangolinie** (Badger SSO). `DASHBOARD_PASSWORD` + sesja to defense-in-depth
  NA WIERZCHU, nie jedyna linia obrony.
- Opcjonalnie można zawęzić `trust proxy` w app z `true` do liczby hopów (Pangolin+nginx = 2) lub do
  podsieci loopback — ale przy bindzie `127.0.0.1` blanket `true` jest bezpieczny (nikt poza nginx nie
  dostarczy nagłówków `X-Forwarded-*` do app).

## 8. Źródła

- [Coolify — Docker Compose (ports, magic env, predefined network)](https://coolify.io/docs/knowledge-base/docker/compose)
- [Pangolin — System Architecture](https://docs.pangolin.net/development/system-architecture) ·
  [Targets](https://docs.pangolin.net/manage/resources/public/targets)
- Pangolin `X-Forwarded-Proto` (wersyjne): [discussion #237](https://github.com/orgs/fosrl/discussions/237) ·
  [issue #1446](https://github.com/fosrl/pangolin/issues/1446)
- [Traefik — forwarded headers](https://community.traefik.io/t/how-to-configure-x-forwarded-for-and-x-forwarded-proto-in-v2/7720)
- [nginx — proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) ·
  [WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
