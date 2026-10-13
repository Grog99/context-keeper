# Context Keeper — Roadmapa

Prosty przegląd: co robimy po kolei i gdzie jesteśmy. Szczegóły → [`prd.md`](prd.md), [`tech-stack.md`](tech-stack.md), [`design-system.md`](design-system.md).

**Aktualizacja:** 2026-10-12 · **Etap:** v1.7 domknięte (proces i jakość) → wchodzimy w **v1.8** (agenci i projekty).

Legenda: ✅ zrobione · 🔨 w toku · ⬜ przed nami

> Pełne opisy zakresu faz 0 → v1.7 zarchiwizowane w
> [`archive/roadmap-2026-10-12-v1.7-complete.md`](archive/roadmap-2026-10-12-v1.7-complete.md).
> Wcześniejsze snapshoty: [v1.6](archive/roadmap-2026-10-08-v1.6-complete.md) · [v1.5](archive/roadmap-2026-10-06-v1.5-complete.md) · [v1.4](archive/roadmap-2026-10-03-v1.4-complete.md) · [v1.3](archive/roadmap-2026-07-29-v1.3-complete.md) ·
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

### v1.7 — Proces i jakość

- **Konwencja testów i test-first** — [`testing.md`](testing.md) (testy tam, gdzie się opłacają);
  w `plan-implement` osobny test-writer pisze testy na czerwono przed implementacją.
- **Luki w testach z przeglądu** — Vitest w `apps/dashboard`, strażnicy logiki recenzenta, throttle
  logowania, macierz portów `surface.middleware` (dług #11–#13).
- **Spec przed ekranem** — `design-system.md` §9.11 Operacje, §9.12 Logowanie i §12 „Spec przed
  kodem" egzekwowany w `plan-implement`. **Odchylenie:** szkic ASCII w §9 zamiast klikalnej makiety.
- **Dokumentacja w tym samym przepływie** — agent docs (Stage 5b) w `plan-implement`, checkbox w
  szablonie PR, reguła w `AGENTS.md`.
- **CI** — `.github/workflows/verify.yml`: `pnpm verify` jako wymagany check przed merge'em do `main`.

---

## v1.8 — Agenci i projekty ⬜

**Cel fazy:** domknąć bugi z przeglądu UX (jeden z nich omija human-gate), dać agentom dwie brakujące
rzeczy — dziennik pracy i auth dla klientów bez stałego tokena — oraz sprawić, żeby przy wielu
projektach dało się je odróżnić na pierwszy rzut oka. Zmiany UI zaczynają się od specu w
[`design-system.md`](design-system.md) (§12).

- **Bugi z przeglądu UX** ⬜ — najpierw, każdy od testu regresji (ścieżki względem
  `apps/dashboard/src/`):
  - **akord `g ‹litera›` odpala akcje kolejki** — `g a` (skok do Audytu) **zatwierdza** zaznaczoną
    propozycję, `g s` klika „Zatwierdź jako zamiennik", `g k` przesuwa zaznaczenie; oba handlery
    słuchają na `document`, `useQueueKeyboard` nie wie o uzbrojonym akordzie
    (`hooks/useKeyboard.ts`). Odtworzone w przeglądarce. Omija human-gate bez potwierdzenia;
  - skrót `A` na nieaktualnej propozycji wysyła request (toast 409) — `handleApprove` nie sprawdza
    `detail.stale` (`screens/QueueScreen.tsx`);
  - klik w podpis „Tagi" w „Nowa pamięć" usuwa pierwszy tag — pole jest `<label>`
    (`screens/HumanCreateDialog.tsx`);
  - Audyt nigdy nie pokazuje ładowania — `isLoading && !isFetching` w React Query v5 jest zawsze
    fałszem (`screens/AuditScreen.tsx`);
  - slug projektu niewidoczny — `MonoId label="slug"` renderuje słowo „slug"
    (`screens/ProjectsScreen.tsx`, `screens/ProjectSettingsDialog.tsx`);
  - globalny `:focus-visible` w `globals.css` przebija `outline-none` (poza warstwą, później w
    pliku) — przenieść do `@layer base` i przejść ekrany, czy fokus nigdzie nie zniknął.
- **Przełącznik projektów od nowa** ⬜ — dziś nieczytelny: nagłówek grupy „Projekty" wygląda jak
  pozycja (styl nagłówków jest tylko w palecie ⌘K), brak ✓ przy aktywnym kontekście, brak separatora
  „Wszystkie/Global" ↔ projekty, brak sluga, input 44 px z ramką fokusu wokół samego pola, „global"
  w triggerze vs „Global" na liście, trigger bez etykiety dostępności. Spec w §9.6 + szkic ASCII.
- **Znak projektu (`ProjectAvatar`)** ⬜ — domyślnie **automatyczny**: monogram 1–2 znaki + kolor
  wyliczony ze sluga (działa bez klikania, także dla projektów od agentów przez `create_project`);
  **opcjonalnie ręczny**: ikona z kuratorowanego zestawu (~24 z lucide) i kolor w ustawieniach
  projektu. **Osobna paleta** (~8 przytłumionych odcieni, tokeny light/dark) spoza statusów (§2.2) i
  `kind` (§2.3) **i zielonego akcentu** (§2.1, od ikony aplikacji). Wszędzie, gdzie pojawia się
  projekt: przełącznik, wiersze Kolejki i Pamięci, Projekty, Audyt. Migracja: nullowalne `projects.icon` / `projects.color`. Spec w §8.2 + §9.3.
  Decyzja 2026-10-12 (pamięć projektu `mem_ymwfih1jboy9`).
- **Ikona aplikacji** ✅ — własny znak „zapieczętowana księga z dziurką od klucza" (metafora
  human-gate) zamiast lucide `Diamond`: `public/favicon.svg` z wariantem dark przez
  `@media (prefers-color-scheme)`, rastry `favicon.ico` (16+32) i `apple-touch-icon.png` (180)
  generowane jednorazowo i commitowane, komponent `BrandMark` w railu i na logowaniu (wariant za `data-theme`,
  tokeny `--brand-*`), znak przy tytule README. **Akcent UI i `info` zmieniły się z irysu na
  butelkową zieleń znaku** (§2.1, P3; kontrast AA zmierzony w obu motywach, strażnik
  `theme-tokens.spec.ts`). `document.title` per ekran: „(N) ‹Ekran› · Context Keeper" (licznik
  kolejki tylko przy N > 0), na logowaniu „Logowanie · Context Keeper". Spec w §2.1, §2.5, §8.2, §9.0.
  **Odchylenie:** w Pomiarach zieleń akcentu leży obok zieleni `success` — zostaje w
  [`backlog.md`](backlog.md), do rozwiązania razem z paletą `ProjectAvatar`.
- **Typ pamięci `journal`** ⬜ — wpis dodawany przez agenta po każdym zrobionym zadaniu (co zrobiono,
  na czym skończono, co zostało otwarte). **Do rozstrzygnięcia przed implementacją** (ticket przez
  `prepare-ticket`): relacja do istniejącego `kind: event` (osobny `kind` czy `event` z
  konwencją/tagiem), czy wpisy idą przez kolejkę akceptacji czy omijają human-gate, jak nie zalać
  retrievalu dziennikiem (osobny filtr / niższa waga w rankingu, retencja), oraz jak wymusić zapis
  „po zadaniu" (opis narzędzia MCP, `AGENTS.md`; hook Stop w pluginie Claude Code zostaje w
  backlogu razem z pluginem).
- **OAuth 2.1 + PKCE dla MCP** ⬜ — dla klientów Desktop / web-connector. Projektować od razu pod
  wymagania nowej specyfikacji MCP (2026-07-28): walidacja issuera, `application_type` w Dynamic
  Client Registration, scope accumulation, credential binding — nie pod stary model. Na obecnym SDK
  v1; migracja na SDK v2 zostaje warunkowa w [`backlog.md`](backlog.md).

## Backlog ⬜

Rzeczy świadomie odłożone poza v1.8 → [`backlog.md`](backlog.md): plugin Claude Code (warunkowy),
migracja na MCP SDK v2 (warunkowa), tuning retrievalu, per-user auth (następny krok po tokenie
konta), token tylko do odczytu, powiadomienia o kolejce, filtr kolejki dla propozycji projektów,
strojenie limitów nocnego jobu, reszta przeglądu UX dashboardu (stany błędu i sesji, klawiatura i
fokus w kolejce, dialogi, filtry w URL, wąskie okno, dostępność), pamięć usera, rewokacja sesji,
skalowanie poziome / interop, oraz pozostały dług techniczny 🟠/🟢 z przeglądu
([`tech-review.md`](tech-review.md)).

**Wycięte** (nie „odłożone"): Memory Worth — prune po współwystąpieniu z sukcesem/porażką. Sygnał outcome
jest z natury zaszumiony (sesja się udała ≠ ta pamięć pomogła), a koszt to nowe narzędzie MCP wymagające
zdyscyplinowanego użycia przez agenta. Score w rankingu jest pluggable, więc temat wraca, jeśli pojawi się
realny sygnał — na razie nie zajmuje miejsca w backlogu. Auto-allow po N spójnych decyzjach — zastąpione
przez auto mode per projekt (v1.6), patrz [`backlog.md`](backlog.md).
