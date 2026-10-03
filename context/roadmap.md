# Context Keeper — Roadmapa

Prosty przegląd: co robimy po kolei i gdzie jesteśmy. Szczegóły → [`prd.md`](prd.md), [`tech-stack.md`](tech-stack.md), [`design-system.md`](design-system.md).

**Aktualizacja:** 2026-10-03 · **Etap:** v1.4 domknięte (dług techniczny + UI) → wchodzimy w **v1.5** (wiele repo), potem **v1.6** (auto mode + nadzór).

Legenda: ✅ zrobione · 🔨 w toku · ⬜ przed nami

> Pełne opisy zakresu faz 0 → v1.4 zarchiwizowane w
> [`archive/roadmap-2026-10-03-v1.4-complete.md`](archive/roadmap-2026-10-03-v1.4-complete.md).
> Wcześniejsze snapshoty: [v1.3](archive/roadmap-2026-07-29-v1.3-complete.md) ·
> [v1.2](archive/roadmap-2026-07-27-v1.2-complete.md) ·
> [v1](archive/roadmap-2026-07-23-v1-complete.md).

---

## Zrobione ✅

**Faza 0 — Planowanie i design** — research prior-art, plan pamięci agentów, PRD, tech-stack, design system + klikalna makieta.

### v1 — Rdzeń

1. **Fundament** — NestJS na Express, Postgres + pgvector w Docker Compose, model danych, projekty z bearer tokenami `ck_`, opcjonalny reverse proxy.
2. **MCP server** — `search_memory` / `get_memory` / `save_memory` na bezstanowym Streamable HTTP, z auth per token, scope, rate-limitingiem i skanerem sekretów.
3. **Retrieval** — hybryda wektor + full-text z fuzją RRF i dwufazowym pobraniem, pluggable provider embeddingów z presetami deploy-time i fail-open do FTS.
4. **Kolejka akceptacji** — tabela `proposals` z transakcyjnym zatwierdzaniem, optimistic concurrency, edit-before-approve i supersession.
5. **Dashboard** — kolejka, przeglądarka pamięci, projekty+tokeny i audyt, z przełącznikiem kontekstu i human-create (fakty, dokumenty, import `.md`).
6. **Nocny job** — proposer (nie executor) dedup / merge / prune wrzucający do tej samej kolejki, pod advisory lockiem i idempotentny.
7. **Utwardzenie** — audit log, `/health` + metryki, backup `pg_dump` z offsite i audit eventem, testy rdzenia, hard-purge jako CLI.
8. **Onboarding / instalator** — `install.sh` generujący `.env` i sekrety z wyborem profili, plus ścieżka PaaS na Coolify z runbookiem.

**Dogfooding** — repo używa własnej wdrożonej instancji jako pamięci projektu (MCP `context-keeper`, kontrakt w [`AGENTS.md`](../AGENTS.md)).

### v1.1 — Walidacja dogfoodingu

- **Seed pamięci grounding-dokumentami** — wdrożona instancja zaseedowana stabilnymi dokumentami przez CLI `seed-memory`.
- **Instrumentacja użycia pamięci** — ekran „Pomiary" (`/pomiary`) na tabeli `search_events`.
- **Dashboard: ręczny trigger nocnego jobu + hard-purge** — ekran „Operacje" (`/operacje`) plus purge per-pamięć.
- **Review bezpieczeństwa publicznego MCP** — pre-auth throttle per-IP na `/mcp`, `helmet` + CSP, bind portów compose do `127.0.0.1`.

### v1.2 — Więcej możliwości agenta + poprawki UI

- **`kind=event` (episodic)** — trzeci rodzaj wpisu z backdatable `event_time`, age-decay w rankingu, ekran „Oś czasu".
- **memory-relations + 1-hop graph boost** — typowane krawędzie (`caused_by`/`follows`/`context_for`) z re-rank-only boostem.
- **Edycja `event_time` po utworzeniu** — korekta backdate’u z formularza edycji.
- **Agent tworzy `kind=document`** — opcjonalny `kind` w `save_memory` przy tych samych guardach.
- **Edycja pamięci przez agenta** — `save_memory` z `supersedes: id` jako proposal `type='update'`.
- **Snippet do wklejenia w cudzym projekcie** — ekran „Onboarding" z blokami do `AGENTS.md` / `CLAUDE.md` i `.mcp.json`.
- **Poprawki UI** — dopieszczenie dashboardu wg design systemu.

### v1.3 — Dostęp i UI

- **Wiele tokenów per projekt + graceful rotation** — `project_tokens` (1 projekt → N etykietowanych tokenów), rotacja token-scoped z okresem `grace` (`TOKEN_GRACE_PERIOD_HOURS`, domyślnie 72h) i osobnym natychmiastowym `revoke`; atrybucja i rate limiting per token.
- **`kind=event` przez agenta (MCP)** — `save_memory` przyjmuje `kind: "event"` z **wymaganym** `event_time` (ta sama `validateEventTime` co human-create, backdate nieograniczony); `event_time` jedzie przez `proposals.payload` i wchodzi do `memories` dopiero przy akceptacji, a dedup dokłada go jako szóste pole hasha wyłącznie dla eventów. `supersedes` na evencie dalej zakazany.
- **Dedup kind-aware** — fix buga: `kind` jako piąte pole content-hasha (migracja 0011 przeliczyła istniejące), ten sam tekst jako `fact` i `document` to dwie pamięci, nie duplikat.
- **Widok diff dla `supersedes`** — word-level inline diff (`<del>`/`<ins>`) z czterema typowanymi fallbackami do dawnego układu dwóch bloków.
- **Czytelność przeglądarki pamięci** — panel szczegółów na pełną wysokość ze scrollem wewnętrznym i przyklejonym paskiem akcji, szerokość czytania zależna od `kind`; plus zachowanie pojedynczych złamań linii, viewport przy niskich oknach i potwierdzenie porzucenia edycji.
- **Zakładka Projekty + wybór projektu w sidebarze** — `PROJECTS_NAV_ITEM` w dolnej sekcji railu (ustawienia projektu ≠ nawigacja kontekstowa), `ContextSwitcher` przeniesiony z top bara do railu.
- **Bulk approve/reject w kolejce** — dwa endpointy-orkiestratory wołające NIETKNIĘTE `approve()`/`reject()` per id (human-gate i audit trail bez zmian), nieatomowe, cap `BULK_MAX_IDS=100`.
- **Poza planem:** rewizja kontrastu + kolor tożsamości dla `kind`, fallback ścieżek `.env`/migracji dla `pnpm dev`, pierwszy przegląd techniczny ([`tech-review.md`](tech-review.md), 15 ustaleń) z synchronizacją `tech-stack.md`.

### v1.4 — Dług techniczny i UI

- **Dług techniczny 🔴 z pierwszego przeglądu** — `Set-Cookie` w `redact` pino i `/health` z wynikiem
  probe współdzielonym przez 5 s (2026-09-10, przed upublicznieniem repo); `ZodValidationPipe` na
  każdym wejściu `dashboard/*.controller.ts` i `Intl.RelativeTimeFormat` zamiast ręcznej drabinki
  (2026-09-27).
- **`kind` w kolejce akceptacji** — `KindGutter` + `KindMarker` w `ProposalRow` i pasku metadanych
  detalu; tagi okazały się już renderowane.
- **Odchylenie od planu:** lepszy prune i `conflicts_report` nie weszły — przeniesione do v1.6, razem
  z auto mode, który daje im skalę do pilnowania.
- **Poza planem:** upublicznienie repo + README z pełną ścieżką instalacji, skille Claude Code
  (`plan-implement`, `roadmap-reconcile`, `tech-reconcile`, `prepare-ticket`).

---

## v1.5 — Wiele repo bez konfiguracji per projekt 🔨

**Cel fazy:** podłączenie kolejnego repo nie wymaga nowego tokena ani zmiany zmiennych środowiskowych.
Dziś token `ck_` jest przypięty do projektu, a `.mcp.json` czyta jedną zmienną `CONTEXT_KEEPER_TOKEN`
— więc każde repo to osobny token i przestawianie środowiska. Po v1.5: jeden token ustawiony raz
globalnie, a repo mówi tylko, którym projektem jest. To też pierwszy krok do wielu użytkowników —
token konta stanie się później tokenem konkretnego usera (per-user auth, backlog).

- **Token konta** ⬜ — token `ck_` nieprzypięty do projektu, ważny dla wszystkich projektów instancji.
  Ten sam cykl życia co tokeny projektowe z v1.3 (etykieta, rotacja z `grace`, natychmiastowy
  `revoke`, atrybucja i rate limiting per token). **Tokeny projektowe zostają pełnoprawne** — dalej
  można mintować nowe dla konkretnego projektu (CI, współpracownik z dostępem do jednego repo, repo
  bez tokena konta); token konta je uzupełnia, nie zastępuje.
- **Wskazanie projektu nagłówkiem** ⬜ — commitowany `.mcp.json` repo dostaje
  `X-Context-Keeper-Project: <slug>`; token przychodzi z globalnej zmiennej. Deterministyczne — nie
  zależy od tego, czy agent poda parametr. Wymaga unikalnego `slug` na `projects` (dziś jest tylko
  nieunikalne `name`) z backfillem dla istniejących projektów.
- **Rozwiązywanie scope'u** ⬜ — `search_memory` / `get_memory` / `save_memory`, `search_events`,
  audyt i rate limiting liczą projekt z pary (token, nagłówek). Nieznany slug albo brak nagłówka przy
  tokenie konta → błąd z listą znanych projektów i wskazówką do onboardingu niżej (**bez**
  auto-create przy zwykłym wywołaniu). Token projektowy + nagłówek innego projektu → błąd.
- **Onboarding przez MCP** ⬜ — narzędzia na poziomie konta, dostępne **tylko** dla tokenu konta i
  bez nagłówka projektu: `list_projects` (podpięcie repo do istniejącego projektu) i
  `create_project`, które zakłada projekt jako **propozycję do kolejki akceptacji** (nowy rodzaj
  propozycji — dziś `proposals` dotyczy tylko pamięci). Oba zwracają gotowy `.mcp.json` z nagłówkiem
  i blok do `AGENTS.md`/`CLAUDE.md`, które agent zapisuje w repo od razu; do akceptacji projektu
  narzędzia z tym nagłówkiem zwracają czytelny status „projekt czeka na akceptację", a po kliknięciu
  w dashboardzie repo działa bez dalszej konfiguracji. **Nigdy nie zwracają tokena** — przy tokenie
  konta nowy nie jest potrzebny, a token w kontekście LLM to ekspozycja. Opcjonalnie prompt MCP
  `onboard` prowadzący agenta przez cały proces (w Claude Code jako slash command).
- **Onboarding pod nowy model** ⬜ — ekran „Onboarding" i README: jednorazowy setup globalny (URL +
  token konta) i gotowy `.mcp.json` per repo z nagłówkiem — ścieżka ręczna obok tej przez MCP.
- **Wyszukiwanie między projektami** ⬜ — z tokenem konta `search_memory` może na jawne życzenie
  (opt-in w parametrze) przeszukać też inne projekty: „jak rozwiązałem to w innym repo". Domyślnie
  bez zmian — tylko bieżący projekt (+ global). Wyniki niosą projekt pochodzenia; `save_memory`
  dalej zapisuje wyłącznie do projektu z nagłówka. Token projektowy nie ma tej opcji.

## v1.6 — Auto mode i nadzór nad skalą ⬜

**Cel fazy:** pozwolić pamięci rosnąć bez recenzenta przy każdym zapisie — i od razu dać nocnemu
jobowi narzędzia, żeby to, co rośnie, dało się utrzymać. Auto mode i nadzór idą w jednej wersji
celowo: auto mode bez lepszego prune i wykrywania sprzeczności to pamięć rosnąca bez kontroli.

- **Auto mode per projekt** ⬜ — przełącznik projektu, domyślnie wyłączony (wzorzec jak
  `include_events_in_default_search`). Obejmuje zapisy **agenta**: `create` i `update` (`supersedes`),
  razem z relacjami. Skaner sekretów i walidacja bez zmian — odrzucony zapis dalej nie wchodzi.
  Auto-zaakceptowane wpisy są oznaczone w audycie i filtrowalne w przeglądarce, żeby dało się je
  przejrzeć po fakcie. Świadome złagodzenie human-gate'u (decyzja „human-gate to feature") — opt-in
  per projekt, nie zmiana domyślna.
- **Bezpieczniki auto mode** ⬜ — przypadki, w których recenzent był jedyną kontrolą, wracają do
  kolejki mimo włączonego przełącznika: (a) **podejrzany duplikat** — dedup przy zapisie łapie dziś
  tylko identyczny hash, a wektor jest „dedup-hintem na przyszłość, nieużywanym"
  (`memory/memory.service.ts`); bez recenzenta prawie-duplikaty weszłyby wprost; (b) **korekta wpisu
  człowieka** (`source=human`, zaufany aktor) przez agenta; (c) **dzienny limit** auto-akceptacji
  per projekt — po jego przekroczeniu reszta idzie do kolejki (bezpiecznik na zapętlonego agenta).
- **Cofanie auto mode** ⬜ — masowa archiwizacja auto-zaakceptowanych wpisów po filtrze (token,
  przedział czasu) na scenariusz „agent przez całą sesję zapisywał śmieci". Przez istniejącą
  archiwizację z audytem, nie hard-delete.
- **Pomiary auto mode** ⬜ — na ekranie „Pomiary": jaki odsetek auto-zaakceptowanych wpisów został
  później zarchiwizowany / nadpisany / przycięty, per projekt. Dane do decyzji, czy auto mode w danym
  projekcie się sprawdza.
- **Propozycje nocnego jobu zawsze do kolejki** ⬜ — merge / delete / prune / dedup i
  `conflicts_report` nie podlegają auto mode, niezależnie od przełącznika projektu.
- **Provider LLM dla nocnego jobu** ⬜ — warunek wstępny dwóch pozycji niżej: nocny job jest dziś
  deterministyczny („BEZ LLM w v1", `nightly/dedup-cluster.ts`), a jedyny zewnętrzny provider to
  embeddingi. Decyzja deploy-time na wzór presetów embeddingów: model lokalny vs API, koszt na
  przebieg, zachowanie przy niedostępności (prune/conflicts pomijane, reszta jobu działa).
- **Lepszy prune w nocnym jobie** ⬜ — mały model przegląda wpisy z ostatniego dnia i proponuje
  usunięcie albo skrócenie tego, co niepotrzebne. **Nie nowy podsystem** — heurystyka w istniejącym
  kroku `prune`, który już jest proposerem. (z v1.4)
- **`conflicts_report`** ⬜ — wykrywanie sprzeczności same-topic w nocnym jobie (sąd LLM). Przy auto
  mode ważniejsze niż wcześniej: korekta, która nie użyła `supersedes`, nie przechodzi już przez oczy
  recenzenta. Dzieli skan i model z prune. (z v1.4)
- **Nocny job na skali** ⬜ — przegląd okna skanu i limitów (dziś do 200 propozycji na przebieg) pod
  wiele projektów z auto mode, żeby kolejka nocnego jobu nie zalała recenzenta. Plus dwie pozycje
  długu 🟠, które bolą właśnie przy tej skali ([`tech-review.md`](tech-review.md)): **#5**
  `GET /api/proposals` bez `LIMIT` (limit + keyset, lista bez payloadów) i **#7** filtr projektu w
  audycie (GIN na `affected_ids` + `EXISTS`).

## Backlog ⬜

Rzeczy świadomie odłożone poza v1.5–v1.6 → [`backlog.md`](backlog.md): plugin Claude Code (warunkowy),
OAuth 2.1 + PKCE, migracja na MCP SDK v2, tuning retrievalu, per-user auth (następny krok po tokenie
konta), token tylko do odczytu, powiadomienia o kolejce, pamięć usera, rewokacja sesji, skalowanie
poziome / interop, oraz pozostały dług techniczny 🟠/🟢 z przeglądu ([`tech-review.md`](tech-review.md)).

**Wycięte** (nie „odłożone"): Memory Worth — prune po współwystąpieniu z sukcesem/porażką. Sygnał outcome
jest z natury zaszumiony (sesja się udała ≠ ta pamięć pomogła), a koszt to nowe narzędzie MCP wymagające
zdyscyplinowanego użycia przez agenta. Score w rankingu jest pluggable, więc temat wraca, jeśli pojawi się
realny sygnał — na razie nie zajmuje miejsca w backlogu. Auto-allow po N spójnych decyzjach — zastąpione
przez auto mode per projekt (v1.6), patrz [`backlog.md`](backlog.md).
