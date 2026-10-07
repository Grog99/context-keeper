# Context Keeper — kontrakt narzędzi MCP (warstwa 1)

**Status:** v1.5 · **Źródło prawdy tekstu:** `apps/server/src/mcp/tool-contract.ts` (opisy narzędzi),
`apps/server/src/onboarding/onboarding-templates.ts` (prompt `onboard`, kroki zapisu) · **Kontekst:**
[`prd.md`](prd.md) §6.1, [`tech-stack.md`](tech-stack.md) §5, §10, §14

> To jest **warstwa 1** trzywarstwowego kontraktu z agentem (tech-stack §14): opisy narzędzi
> niesione przez `tools/list`, widoczne automatycznie dla **każdego** klienta MCP — bez pluginu,
> bez wklejki do `CLAUDE.md`/`AGENTS.md`. Load-bearing polityka (w tym "nie zapisuj sekretów")
> jedzie tutaj, bo agenta, który zapomniał wkleić snippet, i tak trzeba ochronić przed
> zaśmieceniem/zatruciem kolejki.
>
> **Ten dokument nie zawiera tekstu opisów** (od v1.5). Jedynym źródłem jest kod: opisy jadą do
> agentów przez `tools/list`, są składane z kawałków (np. wspólny akapit `PROJECT_SCOPE_ERRORS`
> doklejany do trzech narzędzi pamięci) i pokryte testami e2e — kopia w markdownie tylko by się
> rozjeżdżała (w v1.5 rozjechała się trzykrotnie). Tu zostają zasady i ich uzasadnienia; przy
> każdym narzędziu jest odsyłacz do stałej. Opisy są po angielsku — adresowane do dowolnego agenta
> LLM, nie tylko polskojęzycznego operatora.

---

## Widoczność narzędzi i promptu per typ tokena

Zestaw narzędzi i prompt zależą **wyłącznie** od `auth.tokenScope` (`mcp/mcp-server.factory.ts`,
`createMcpServer`) — nigdy od nagłówka ani stanu bazy, więc `initialize`/`tools/list` nie robią
zapytań do bazy.

| Token | Nagłówek `X-Context-Keeper-Project` | `tools/list` | Prompt `onboard` (capability `prompts`) | Narzędzia pamięci działają w |
|---|---|---|---|---|
| projektowy | brak albo slug własnego projektu | `search_memory`, `get_memory`, `save_memory` | nie | projekcie tokena |
| projektowy | inny slug | j.w. | nie | — → `project_forbidden` |
| konta | brak | 3 narzędzia pamięci + `list_projects`, `create_project` | tak | — → `project_required` |
| konta | slug istniejącego projektu | j.w. | tak | projekcie z nagłówka |
| konta | slug oczekującej propozycji `create_project` | j.w. | tak | — → `project_pending` |
| konta | slug nieznany albo w złym formacie | j.w. | tak | — → `project_not_found` |

- Narzędzia konta widzi token konta **zawsze**, z nagłówkiem i bez — świadome odstępstwo od roadmapy
  (#13: „tylko bez nagłówka”). Powód: widoczność nie może zależeć od stanu, który zmienia się między
  requestami, a właśnie te narzędzia naprawiają złą konfigurację nagłówka.
- Token projektowy wywołujący `list_projects`/`create_project` dostaje własny błąd SDK „Tool not
  found” — poza naszą taksonomią (narzędzi nie ma na `tools/list`).
- `prompts/list`/`prompts/get` tokenem projektowym są odrzucane (brak capability).
- Token jest tokenem konta, gdy `project_tokens.project_id IS NULL`. Reguła żyje w jednym miejscu:
  `tokenScopeOf` w `projects/project-scope.ts`.

## Wybór projektu — nagłówek `X-Context-Keeper-Project`

Źródło: `projects/project-scope.ts` (`resolveProjectScope`, wołane z `BearerGuard`). Wartość nagłówka
jest przycinana i sprowadzana do lowercase (`normalizeProjectSlugInput`); pusta wartość = brak nagłówka.

- **Token projektowy:** brak nagłówka albo slug równy własnemu → projekt tokena. Każdy inny slug →
  `project_forbidden`, bez zapytania do bazy i bez echa wartości (anty-probing: odpowiedź identyczna,
  czy slug istnieje, czy nie).
- **Token konta:** brak nagłówka → `project_required`. Slug w złym formacie → `project_not_found` (bez
  zapytania). Trafienie w `projects.slug` → ten projekt. Oczekująca propozycja `create_project` →
  `project_pending`. W pozostałych przypadkach → `project_not_found`.
- **Nierozwiązany projekt nigdy nie odrzuca żądania HTTP.** Każdy ważny token przechodzi, a narzędzie
  pamięci zwraca błąd tool-level. Dlaczego: przy HTTP 4xx klient MCP uznałby serwer za niepodłączony i
  agent nigdy nie zobaczyłby wskazówki.
- Narzędzia konta nie wymagają rozwiązanego projektu — ich zadaniem jest naprawa właśnie tej konfiguracji.
- `details.projects` jest pobierane leniwie, dopiero przy budowie błędu (`mcp/scope-errors.ts`,
  `buildScopeError`); `message` wymienia najwyżej 20 slugów (`MESSAGE_SLUG_CAP`), pełna lista zawsze jest
  w `details.projects`.
- Wszystkie trzy opisy narzędzi pamięci kończą się wspólnym akapitem `PROJECT_SCOPE_ERRORS`
  (`tool-contract.ts`): jak wybierany jest projekt, 4 kody i akcja dla każdego, oraz „konfiguracja, nie
  błąd przejściowy — nie ponawiaj w pętli”.

## Zakres odczytu i zapisu

Polityka typ tokena → zakres: `mcp/read-scope-policy.ts` (`searchReadScope`, `getReadScope`). Sam zakres
liczy jedno miejsce: `memory/read-scope.ts` (`readScopeCondition` / `isReadable`).

- **`search_memory`, domyślnie:** projekt bieżący + `global`.
- **`search_memory` z `all_projects: true`:**
  - `global` + każdy projekt instancji w jednej puli RRF, bez preferencji bieżącego projektu.
  - Każdy wynik niesie `project` (slug albo `null` dla global); w trybie domyślnym pola nie ma.
  - Domyślny zestaw `kind` wynika z togglea **bieżącego** projektu.
  - Nadal wymaga rozwiązanego projektu (nagłówka) — `requireProject()` biegnie jako pierwsze.
  - Tylko token konta. Token projektowy dostaje jawny `validation_error`
    (`ALL_PROJECTS_REQUIRES_ACCOUNT_TOKEN`) zamiast cichego zignorowania klucza — dlatego parametr jest
    w schemacie dla obu typów tokena.
  - Klucz musi mieć dokładnie postać snake_case; błędnie napisany (np. `allProjects`) jest ignorowany i
    agent dostaje wyszukiwanie domyślne.
- **`get_memory`:**
  - Token projektowy: projekt + `global`; poza zakresem albo brak id → to samo `not_found` (anty-IDOR).
  - Token konta: pamięć dowolnego projektu + `global`, zawsze, bez parametru; `not_found` tylko dla
    nieznanego lub niezatwierdzonego id. Dlaczego: token konta i tak czyta każdy projekt przez zmianę
    nagłówka, więc anty-IDOR niczego tu nie chronił.
  - Liczniki dostępu (`access_count`/`last_accessed_at`) rosną w obu trybach.
- **`save_memory`** (także gate'y `supersedes`/`relations`): zawsze tylko projekt z nagłówka/tokena.
  Szerszy odczyt nigdy nie otwiera zapisu na obce id — gate'y dzielą `MemoryService.inScope`.

## Narzędzia

### `search_memory`

**Źródło tekstu:** `SEARCH_MEMORY_DESCRIPTION` + `PROJECT_SCOPE_ERRORS`
(`apps/server/src/mcp/tool-contract.ts`); schemat wejścia w `mcp/mcp-server.factory.ts`.

**Zasady:**

- Wyszukiwanie dwufazowe: nagłówki, potem `get_memory(id)` po pełne body.
- `excerpt` tylko dla `document` i tylko gdy jest wektor zapytania (bez niego nie ma czym wybrać
  fragmentu).
- Domyślny `kind` = fact + document, plus event, gdy włączył to operator na projekcie; przy
  `all_projects` rozstrzyga toggle bieżącego projektu.
- `tags` = dopasowanie any-of.
- Degradacja (brak embeddingu) → ciche FTS-only, bez sygnału dla agenta.
- Pusta lista to nie błąd.
- `all_projects` — patrz „Zakres odczytu i zapisu”; opis ostrzega dodatkowo, że konwencje innego
  projektu mogą nie dotyczyć bieżącego.

### `get_memory`

**Źródło tekstu:** `GET_MEMORY_DESCRIPTION` + `PROJECT_SCOPE_ERRORS`.

**Zasady:**

- Zakres zależy od typu tokena (patrz „Zakres odczytu i zapisu”).
- Nieznane id i id poza zakresem tokena projektowego dają ten sam `not_found` — świadomie, żeby nie
  wyciekać informacji o cudzych projektach.
- Tokenem konta `supersedes`/`relations` w `save_memory` nadal przyjmują tylko id z projektu z nagłówka.

### `save_memory` (load-bearing — pełny kontrakt)

**Źródło tekstu:** `SAVE_MEMORY_DESCRIPTION` + `PROJECT_SCOPE_ERRORS`.

**Zasady:**

- Zapis fire-and-forget, w dwóch trybach zależnych od projektu (opis jest statyczny i nazywa oba):
  **human-gated** (domyślny) — powstaje propozycja, a pamięć jest widoczna dopiero po zatwierdzeniu;
  **auto mode** (v1.6, opt-in per projekt) — zapis, który przejdzie bezpieczniki serwera, jest
  zatwierdzany od razu i wraca jako `approved`. Statusy `pending` / `duplicate_pending` /
  `already_exists` / `approved` nie są błędami.
- `approved` (tylko auto mode): `id` to zawsze id **pamięci** — nowej, a przy `supersedes` korygowanego
  celu (bez zmiany id) — więc nadaje się od razu do `get_memory` i jako `targetId` relacji. Przy
  `pending` z `supersedes` `id` jest id **propozycji** korekty (nie celu) — opis ostrzega, żeby nie
  przekazywać go do `get_memory`.
- Zapis zawrócony przez bezpiecznik auto mode zwraca zwykłe `pending`; **powód zawrócenia nigdy nie
  trafia do agenta** (nie uczy się omijać hamulca) — widzi go recenzent w kolejce. Tryb projektu jest
  niewidoczny i niezmienialny przez MCP (żadne narzędzie nie czyta ani nie zmienia przełącznika;
  `save_memory` nie ma pola auto); agent ma obsłużyć oba statusy i nie ponawiać zapisu `pending`,
  żeby uzyskać `approved`.
- Zapis zawsze trafia do projektu z nagłówka/tokena, nigdy do `global` (promocja do global to akcja
  człowieka).
- `supersedes`: tylko `fact`/`document` własnego projektu, ten sam `kind` co cel; nigdy `event` ani
  `global`; korekta jest wyłączona z dedupu, bo ma z natury przypominać to, co zastępuje.
- `relations`: do 16 krawędzi `caused_by` | `follows` | `context_for`; celem może być `event`; cel
  `global` i self-loop są odrzucane.
- `event` wymaga `event_time` (czas ZDARZENIA, nie zapisu; brak domyślnego „teraz”).
- Sekrety → `secret_blocked`, bez redakcji w miejscu — agent przepisuje treść, odwołując się do
  sekretu po nazwie.
- Limit 429 jest per token × narzędzie, a przy tokenie konta osobno dla każdego projektu.

### `list_projects` (tylko token konta)

**Źródło tekstu:** `LIST_PROJECTS_DESCRIPTION` (`apps/server/src/mcp/tool-contract.ts`).

**Zasady:**

- Read-only, bez human-gate, działa bez rozwiązanego projektu.
- Zwraca `{projects: [{slug, name, mcpJson}], agentsMd, claudeMd, mcpUrlConfigured, hint}`
  (`onboarding/onboarding.service.ts`, `ListProjectsResult`).
- **Nigdy nie zwraca tokena:** `Authorization` to literalny placeholder `${CONTEXT_KEEPER_TOKEN}`
  (`TOKEN_ENV_PLACEHOLDER`).
- `hint` = zdanie otwierające dobrane do sytuacji + `ONBOARDING_SETUP_STEPS`.
- `mcpUrlConfigured: false` oznacza, że URL w `mcpJson` jest placeholderem (nie ustawiono
  `PUBLIC_MCP_URL`/`ACME_DOMAIN`).
- Rate limit: klucz `tokenId:account`, limit `RATE_LIMIT_SEARCH_PER_MIN`.

### `create_project` (tylko token konta)

**Źródło tekstu:** `CREATE_PROJECT_DESCRIPTION`; logika w `onboarding/project-proposal.service.ts`.

**Zasady:**

- Human-gated: tworzy wiersz `proposals` z `type='create_project'`; projekt powstaje dopiero po
  zatwierdzeniu.
- Slug: trim + lowercase, `^[a-z0-9]+(-[a-z0-9]+)*$`, 2–48 znaków. Nazwa: jedna linia (białe znaki
  zwinięte), 1–200 znaków, przechodzi skaner sekretów.
- Zwraca `{status: 'pending', proposalId, project: {slug, name}, mcpJson, agentsMd, claudeMd,
  mcpUrlConfigured, next}`, gdzie `next` = zdanie otwierające + `ONBOARDING_SETUP_STEPS`.
- Agent może skonfigurować repo od razu; po zatwierdzeniu ta sama konfiguracja zaczyna działać, do tego
  czasu narzędzia pamięci zwracają `project_pending`.
- Zatwierdzenie zakłada projekt **bez tokena**; odrzucenie zwalnia slug.
- Audyt: aktor `agent:account` + `metadata.{tokenId, tokenLabel}`.
- Własny niski limit `RATE_LIMIT_CREATE_PROJECT_PER_MIN` (domyślnie 3/min), klucz `tokenId:account`.

### Prompt `onboard` (tylko token konta)

**Źródło tekstu:** `ONBOARD_PROMPT_NAME`, `ONBOARD_PROMPT_TITLE`, `ONBOARD_PROMPT_DESCRIPTION`,
`ONBOARD_PROMPT_TEXT` (`apps/server/src/onboarding/onboarding-templates.ts`); kroki zapisu:
`ONBOARDING_SETUP_STEPS` (ten sam plik).

**Zasady:**

- Widoczny wyłącznie dla tokena konta, z nagłówkiem i bez.
- Bez argumentów; tekst statyczny — `prompts/get` nie dotyka bazy ani tokena i nie ma rate limitu.
- Tylko orkiestruje narzędzia; dane (lista projektów, bloki) pochodzą z `list_projects`/`create_project`.
- **Nic load-bearing:** cała polityka zapisu (scalanie `.mcp.json`, idempotentne `AGENTS.md`/`CLAUDE.md`,
  sprawdzenie `CONTEXT_KEEPER_TOKEN` bez wypisywania go, precedencja wpisów, diff przed zapisem) żyje w
  `ONBOARDING_SETUP_STEPS` i dociera do każdego klienta przez `hint`/`next`. Agent, który promptu nigdy
  nie wywoła, dostaje te same kroki.
- Prompt to dodatek, który wywołuje człowiek (np. `/context-keeper:onboard` w Claude Code).

---

## Taksonomia błędów (referencja szybka — pełny opis w tech-stack §5)

| Warstwa | Przypadek | Sygnał |
|---|---|---|
| Tool-level (`isError: true` + `{code, message, details?}`) | walidacja poza limitem | `validation_error` |
| | sekret wykryty przy `save_memory` | `secret_blocked` |
| | narzędzie pamięci, token konta bez nagłówka `X-Context-Keeper-Project` | `project_required` + `details.projects` (`[{slug, name}]`, wszystkie projekty) |
| | narzędzie pamięci, token konta, slug z nagłówka nie istnieje albo ma zły format | `project_not_found` + `details.projects` |
| | narzędzie pamięci, token konta, slug należy do oczekującej propozycji `create_project` | `project_pending` (bez `details`) |
| | narzędzie pamięci, token projektowy + nagłówek z innym slugiem niż projekt tokena | `project_forbidden` (bez `details`, stały komunikat bez echa slugu — anty-probing) |
| | `search_memory` z `all_projects: true` tokenem projektowym | `validation_error` |
| | `get_memory` — token projektowy: poza scope (projekt + `global`) lub nieistniejące; token konta: nieistniejące / niezatwierdzone (odczyt dowolnego projektu jest dozwolony) | `not_found` (nieodróżnialne — anty-probing) |
| | `save_memory` z `supersedes` — target nieznany lub poza scope (IDOR-safe, jak `get_memory`) | `not_found` |
| | `save_memory` z `supersedes` — target `kind=event`, `kind` korekty ≠ `kind` targetu, lub target `scope=global` | `validation_error` |
| | `save_memory` z `relations` — target nieznany lub poza scope (IDOR-safe, jak `get_memory`; `kind=event` jako target JEST dozwolony, świadome odstępstwo od `supersedes`) | `not_found` |
| | `save_memory` z `relations` — target `scope=global`, self-loop, albo ponad limit (max 16) | `validation_error` |
| | `save_memory` z `kind="event"` bez `event_time` albo z niepoprawnym ISO | `validation_error` |
| | `save_memory` z `event_time` przy `kind` innym niż `event` | `validation_error` |
| | `save_memory` z `kind="event"` + `supersedes` (korekta zdarzenia human-only) | `validation_error` |
| | `create_project` — slug w złym formacie, projekt o tym slugu już istnieje, propozycja tego slugu już oczekuje, nazwa pusta po normalizacji | `validation_error` |
| | `create_project` — nazwa wygląda jak sekret | `secret_blocked` |
| Transport (HTTP) | zły/brak/nieusable bearer (projektowy lub konta — ten sam komunikat) | `401` |
| | rate limit — per token × projekt × narzędzie (klucz `tokenId:projectId`); narzędzia konta per token (`tokenId:account`), `create_project` z własnym niskim limitem; przed auth throttle per IP | `429` + `Retry-After` |
| Nie-błąd (status w wyniku `save_memory`) | — | `pending` / `duplicate_pending` / `already_exists` / `approved` (v1.6, tylko auto mode) |

Błędy scope'u projektu sprawdzane są na początku handlera narzędzia (`requireProject()`) — przed naszą
walidacją (`validation_error`) i logiką narzędzia, bez skutków ubocznych (audyt, `search_events`) i bez
zużycia budżetu rate limitu. Wcześniej działa tylko walidacja `inputSchema` w SDK MCP: argumenty
niezgodne ze schematem dają surowy błąd SDK (`isError` bez koperty `{code}`).

`code` i kształt `details` są stabilne (agenci mogą je parsować) — `message` może się zmieniać. Źródło
kodów: `apps/server/src/common/errors.ts` (`ToolErrorCode`, `ProjectScopeErrorCode`,
`ToolErrorEnvelope`).

## Warstwy 2 i 3

- **Warstwa 2** — snippet do `AGENTS.md` (+ `@AGENTS.md` w `CLAUDE.md`), serwowany przez **serwer**:
  stałe `AGENTS_MD_BLOCK`, `CLAUDE_MD_BLOCK` i funkcja `renderMcpJson` w
  `onboarding/onboarding-templates.ts`. Jedno źródło dla narzędzi MCP (`agentsMd`/`claudeMd`/`mcpJson` w
  `list_projects`/`create_project`) i dla dashboardu (`GET /api/onboarding`, ekran „Onboarding”). Forma
  połączenia: `Authorization: Bearer ${CONTEXT_KEEPER_TOKEN}`, dla tokena konta dodatkowo nagłówek
  `X-Context-Keeper-Project`.
- **Prompt `onboard`** — dodatek do warstwy 2, nie nowa warstwa; nic load-bearing (patrz wyżej).
- **Warstwa 3** — plugin Claude Code: warunkowy ⏸️, w [`backlog.md`](backlog.md) (budowany tylko jeśli
  ekran Pomiary pokaże, że MCP + `AGENTS.md` nie wystarczają).
