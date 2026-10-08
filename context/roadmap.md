# Context Keeper — Roadmapa

Prosty przegląd: co robimy po kolei i gdzie jesteśmy. Szczegóły → [`prd.md`](prd.md), [`tech-stack.md`](tech-stack.md), [`design-system.md`](design-system.md).

**Aktualizacja:** 2026-10-08 · **Etap:** v1.6 domknięte (auto mode + nadzór) → wchodzimy w **v1.7** (proces i jakość).

Legenda: ✅ zrobione · 🔨 w toku · ⬜ przed nami

> Pełne opisy zakresu faz 0 → v1.6 zarchiwizowane w
> [`archive/roadmap-2026-10-08-v1.6-complete.md`](archive/roadmap-2026-10-08-v1.6-complete.md).
> Wcześniejsze snapshoty: [v1.5](archive/roadmap-2026-10-06-v1.5-complete.md) · [v1.4](archive/roadmap-2026-10-03-v1.4-complete.md) · [v1.3](archive/roadmap-2026-07-29-v1.3-complete.md) ·
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

### v1.5 — Wiele repo

- **Token konta + projekt z nagłówka** — token `ck_` bez projektu ważny w całej instancji, projekt
  wskazuje `X-Context-Keeper-Project: <slug>` z commitowanego `.mcp.json`; unikalny slug z
  backfillem, błędy scope'u `project_*` jako tool-level, rate limit per token × projekt.
- **Onboarding przez MCP** — `list_projects` / `create_project` (propozycja projektu w kolejce
  akceptacji), prompt `onboard`; ekran „Onboarding" i README pod nowy model, bloki renderowane przez
  serwer.
- **Wyszukiwanie między projektami** — `search_memory(all_projects: true)` dla tokenu konta, wyniki z
  projektem pochodzenia; `get_memory` tokenem konta czyta każdy projekt.
- **Odchylenie od planu:** narzędzia konta widoczne dla tokenu konta zawsze (nie „tylko bez
  nagłówka"), approve projektu bez tokena, slug edytowalny bez aliasów, token projektowy z
  `all_projects` dostaje `validation_error` — szczegóły w snapshocie v1.5.
- **Poza planem:** dogfooding tego repo na tokenie konta + nagłówek, synchronizacja kanonu z v1.5
  (`mcp-tool-contract.md` jako dokument zasad, źródłem opisów narzędzi jest kod).

### v1.6 — Auto mode i nadzór

- **Auto mode per projekt + bezpieczniki** — przełącznik i dzienny limit per projekt; zapisy agenta
  zatwierdza maszyna, chyba że bezpiecznik zawróci je do kolejki (prawie-duplikat, brak sygnału,
  korekta wpisu człowieka, dzienny limit). Wcześniej osobno: podpowiedź „podobne do istniejących" w
  kolejce.
- **Nadzór po fakcie** — cofanie auto mode (masowa archiwizacja po przedziale czasu i tokenie) i
  pomiary losu auto-akceptacji na „Pomiarach".
- **Nocny job z LLM** — provider konfigurowany w bazie i na ekranie „Ustawienia" (klucz szyfrowany,
  fail-open), lepszy prune i `conflicts_report` z zamianą kierunku przez recenzenta; propozycje
  nocnego jobu zawsze idą do kolejki.
- **Nocny job na skali** — keyset paging kolejki i audytu, filtr projektu w audycie (dług #5, #7).
- **Odchylenie od planu:** strojenie limitów nocnego jobu (C2) → [`backlog.md`](backlog.md).
- **Poza planem:** parytet zmiennych env w trzech plikach compose + test i reguła w `AGENTS.md`.

---

## v1.7 — Proces i jakość ⬜

**Cel fazy:** repo rozwijane głównie przez agentów potrzebuje bramek, które nie zależą od pamięci
człowieka ani agenta. Dziś builder pisze testy pod własny kod, ekrany powstają bez specu w design
systemie, kanon dogania kod zbiorczo po wersji (v1.5 wymagało osobnego PR #44), a `pnpm verify`
chodzi tylko lokalnie. Po v1.7: testy przed kodem i tylko tam, gdzie się opłacają, spec przed
ekranem, dokumentacja aktualizowana w tym samym przepływie co zmiana, CI jako bramka merge'a.

- **Konwencja testów i test-first** ⬜ — spisana konwencja: testy dla **najważniejszych miejsc**
  (kontrakt MCP, human-gate, scope i auth, retrieval, migracje), przemyślane — nie pokrycie dla
  pokrycia i nie zapychanie aplikacji testami; co mockować i gdzie leżą. W przepływie
  `plan-implement` **osobny agent pisze testy przed implementacją** (z planu, na czerwono), a
  **osobny agent implementuje**, aż przejdą — builder nie pisze testów pod własny kod.
- **Luki w testach z przeglądu technicznego** ⬜ — Vitest w `apps/dashboard` (dziś `pnpm verify` jest
  server-only), test throttlingu logowania, test `surface.middleware`. Według nowej konwencji, nie
  „na zapas". (z backlogu, dług 🟠)
- **Design dla każdego ekranu** ⬜ — `design-system.md` §9 dostaje sekcje brakujących ekranów
  (Pomiary, Operacje, Logowanie), plus reguła na przyszłość: nowy ekran albo większa zmiana UI
  najpierw dostaje spec w design systemie (i makietę), dopiero potem kod.
- **Aktualizacja dokumentacji przez agenta** ⬜ — agent dokumentacji jako etap przepływu po
  implementacji: aktualizuje kanon (`context/`), README i `AGENTS.md` pod to, co weszło, zamiast
  zbiorczej synchronizacji po zamknięciu wersji.
- **CI** ✅ — `.github/workflows/verify.yml`: `pnpm verify` na każdym PR i pushu do `main`
  (`ubuntu-latest`, testy integracyjne przez testcontainers), job `verify` jako wymagany check w
  ochronie `main`. Deploy na Coolify zostaje automatyczny po wejściu zmian na `main` — świadomie bez
  gatingu, bo merge i tak wymaga zielonego `verify`.

## Backlog ⬜

Rzeczy świadomie odłożone poza v1.7 → [`backlog.md`](backlog.md): plugin Claude Code (warunkowy),
OAuth 2.1 + PKCE, migracja na MCP SDK v2, tuning retrievalu, per-user auth (następny krok po tokenie
konta), token tylko do odczytu, powiadomienia o kolejce, filtr kolejki dla propozycji projektów, strojenie limitów nocnego jobu, pamięć usera, rewokacja sesji, skalowanie
poziome / interop, oraz pozostały dług techniczny 🟠/🟢 z przeglądu ([`tech-review.md`](tech-review.md)).

**Wycięte** (nie „odłożone"): Memory Worth — prune po współwystąpieniu z sukcesem/porażką. Sygnał outcome
jest z natury zaszumiony (sesja się udała ≠ ta pamięć pomogła), a koszt to nowe narzędzie MCP wymagające
zdyscyplinowanego użycia przez agenta. Score w rankingu jest pluggable, więc temat wraca, jeśli pojawi się
realny sygnał — na razie nie zajmuje miejsca w backlogu. Auto-allow po N spójnych decyzjach — zastąpione
przez auto mode per projekt (v1.6), patrz [`backlog.md`](backlog.md).
