# Context Keeper — Backlog

Rzeczy świadomie odłożone poza bieżącą wersję. Nie są porzucone — czekają na decyzję albo na sygnał
z danych (część jest **warunkowa**). Aktywny plan i to, co robimy teraz → [`roadmap.md`](roadmap.md).

**Aktualizacja:** 2026-10-12 · otwarcie v1.8 („Agenci i projekty"): do [`roadmap.md`](roadmap.md)
poszły OAuth 2.1 + PKCE, typ pamięci `journal`, bugi z przeglądu UX, przełącznik projektów ze znakiem
projektu (`ProjectAvatar`) i ikona aplikacji. Plugin Claude Code i migracja na SDK v2 zostają tu jako
warunkowe. Tego samego dnia przegląd UX dashboardu rozbudował sekcję „Dashboard / UI" (stany błędu,
klawiatura, dialogi, filtry w URL, wąskie okno — zostają tu). Wcześniej tego dnia —
domknięcie v1.7 (snapshot
[`archive/roadmap-2026-10-12-v1.7-complete.md`](archive/roadmap-2026-10-12-v1.7-complete.md)): bez
przesunięć między roadmapą a backlogiem, zakres v1.8 do wybrania stąd; doszły ikona aplikacji i typ
pamięci `journal`.
2026-10-08 — domknięcie v1.6: z [`roadmap.md`](roadmap.md) wróciło strojenie
limitów nocnego jobu (C2, warunkowe — czeka na realną mieszankę propozycji z prune i
`conflicts_report`); lepszy prune, `conflicts_report`, auto mode i dług 🟠 #5/#7 zrobione w v1.6.
2026-10-06 — domknięcie v1.5: trzy pozycje długu testowego 🟠 (Vitest w
`apps/dashboard`, test throttlingu logowania, test `surface.middleware`) przeszły do
[`roadmap.md`](roadmap.md), v1.7 („Luki w testach z przeglądu technicznego"); doszedł filtr kolejki
dla propozycji projektów (odłożony z v1.5). 2026-10-03 — sesja planowania v1.5–v1.6: lepszy prune
i `conflicts_report` przeszły w [`roadmap.md`](roadmap.md) z v1.4 do v1.6 (razem z auto mode); „Auto-allow po N spójnych decyzjach"
zastąpione przez auto mode per projekt (v1.6) → „Wycięte"; per-user auth zostaje tu jako następny krok
po tokenie konta z v1.5; dług 🟠 #5 (`GET /api/proposals` bez `LIMIT`) i #7 (audyt per projekt)
poszły do v1.6 („Nocny job na skali"); doszły token tylko do odczytu i powiadomienia o kolejce.
2026-07-29 (wieczór) — przy otwarciu v1.4 do [`roadmap.md`](roadmap.md) poszły:
lepszy prune w nocnym jobie, `conflicts_report`, „tagi i `kind` w kolejce akceptacji" (dawne
„Brak tagów przy akceptacji") oraz cztery pozycje długu 🔴 (`Set-Cookie` w logach, walidacja
query-paramów `/api`, throttle na `/health`, `Intl.RelativeTimeFormat`). Wcześniej tego samego dnia
doszła sekcja „Dług techniczny / architektura" z pierwszego przeglądu technicznego
([`tech-review.md`](tech-review.md), 15 pozycji). 2026-07-27 — przegląd przy wejściu w v1.3: wiele
tokenów + rotacja, cała sekcja UI, dedup kind-aware, bulk approve/reject; Memory Worth wycięte
(patrz sekcja niżej).

Legenda: ⬜ przed nami · ⏸️ warunkowe (czeka na sygnał / decyzję)

---

## Agent / MCP

- **Plugin Claude Code** ⏸️ — bundle: config połączenia + skill proaktywności („Warstwa 3" kontraktu
  narzędzi). **Warunkowy:** budujemy tylko, jeśli instrumentacja (ekran Pomiary) pokaże, że czysty
  MCP + `AGENTS.md` nie wymuszają proaktywnego recallu. v1.2 najpierw wyciska maksimum z samego MCP.
- **Migracja na nowy standard MCP / SDK v2** ⏸️ — spec z 2026-07-28 wprowadza m.in. stateless
  architecture (bez handshake `initialize`), MRTR (`InputRequiredResult` w trakcie wywołania) i
  standaryzację kodów błędów JSON-RPC. TS SDK v2 jest **ESM-only** (Node 20+, split na
  `@modelcontextprotocol/server`/`client`, Standard Schema) — realny koszt w naszym CommonJS-owym
  NestJS (`apps/server`), nie coś do zrobienia przy okazji. Bety zachowują kompatybilność wsteczną
  z v1 SDK, brak twardego terminu wymuszającego zmianę. Nasz transport MCP jest już bezstanowy
  (Faza 2, `StreamableHTTPServerTransport` bez sesji) — kierunek nowej specyfikacji już pasuje do
  architektury. **Warunkowe:** wracamy do tematu, gdy SDK v2 się ustabilizuje albo pojawi się
  konkretna potrzeba (np. przy OAuth w v1.8, który powstaje na obecnym SDK v1).

- **Ekran „Dziennik"** ⏸️ — osobny widok wpisów `journal` (route + spec w `design-system.md` §9 +
  nawigacja) zamiast samego filtra `kind` w Przeglądarce pamięci. Odłożone z v1.8 (2026-10-13): na
  start wystarcza filtr, a zakres wersji był już duży. **Warunkowe:** wracamy, gdy przegląd dziennika
  przez filtr okaże się niewygodny (wpisy po każdym zadaniu to wysoki wolumen).
- **`all_projects` w `list_journal`** ⏸️ — dziś `list_journal` czyta wyłącznie bieżący projekt,
  także tokenem konta (dziennik jest z natury per repo). Parametr dla tokenu konta (jak
  `search_memory`) otworzyłby „co robiono w innych repo" — dodatkowa ścieżka i testy scope'u.
  Odłożone z v1.8 (2026-10-13). **Warunkowe:** wracamy, gdy pojawi się potrzeba przeglądu dzienników
  wielu repo naraz (dziś obejście: `search_memory(kind: "journal", all_projects: true)`).
- **Osobny dzienny limit auto mode dla `journal` + licznik per `kind` na Pomiarach** ⏸️ — auto-
  akceptacje `journal` liczą się dziś do wspólnego `auto_mode_daily_limit` (domyślnie 50 / projekt /
  24 h), więc aktywny agent może wstrzymać fakty powodem `daily_limit`; „Pomiary" nie dzielą
  auto-akceptacji ani wstrzymań per `kind`, więc widać to tylko po powodach zawróceń. Odłożone z v1.8
  (2026-10-13). **Warunkowe:** wracamy, jeśli Pomiary pokażą wstrzymania `daily_limit` wywołane
  dziennikiem (osobna kolumna + pole w Ustawieniach albo wyłączenie `journal` z limitu).

> OAuth 2.1 + PKCE → w v1.8 ([`roadmap.md`](roadmap.md)). Typ pamięci `journal` → zrobiony w v1.8
> (`kind=journal` + narzędzie `list_journal`, [`roadmap.md`](roadmap.md)). Hook Stop wymuszający
> wpis `journal` należy do pluginu wyżej i czeka razem z nim.

## Retrieval i higiena pamięci

- **Tuning retrievalu na realnych danych** ⬜ — top-k, próg relevance, próg dedup, `k` RRF, chunking
  (PRD §11). Karmi się instrumentacją z Pomiarów — pomiar najpierw, dostrojenie potem.
- **Model embeddingów żywej instancji: bge-m3 zamiast text-embedding-3-small** ⬜ — rozważyć przejście
  na bge-m3 (albo inny model wielojęzyczny), bo text-embedding-3-small nie łapie parafraz między
  językami EN↔PL. Zmierzone przy A1 (2026-10-07): angielskie parafrazy polskich faktów — 0–1 z 13
  złapanych na text-embedding-3-small vs 10 z 13 na bge-m3 przy progu 0.20 (dystanse EN↔PL 0.26–0.34
  nakładają się na różne fakty, żaden próg tego nie naprawi). Dotyczy i hintu „podobne do istniejących",
  i samego retrievalu. Wymaga `reembed` — decyzja o presecie przy deployu. **Poza zakresem A1.**

- **Strojenie limitów nocnego jobu** ⏸️ — sufit pending propozycji nocnych, podział capu
  `NIGHTLY_MAX_PROPOSALS_PER_RUN` (dziś 200) na projekty, priorytet typów przy obcinaniu (dziś
  leksykograficzny po `conditionKey`, rozkład na projekty przypadkowy), liczniki per projekt. Ticket
  C2 `nightly-queue-tuning`; pytania wejściowe P7–P10 na końcu
  [`.tickets/nightly-scale.md`](../.tickets/nightly-scale.md). Odłożone z v1.6 (2026-10-08).
  **Warunkowe:** wracamy, gdy włączony LLM (prune + `conflicts_report`) da realną mieszankę propozycji
  albo cap zacznie obcinać przebiegi (`skippedCap > 0` w logu / licznikach nocnego jobu).

> `conflicts_report` i „lepszy prune w nocnym jobie" → zrobione w v1.6
> ([`archive/roadmap-2026-10-08-v1.6-complete.md`](archive/roadmap-2026-10-08-v1.6-complete.md)).

## Kolejka akceptacji

- **Powiadomienia o kolejce** ⬜ — webhook / Slack / mail (np. dzienny digest) o oczekujących
  propozycjach. Przy wielu repo nikt nie zagląda do dashboardu bez powodu; kolejka bez recenzenta
  to pamięć, która stoi w miejscu.
- **Filtr kolejki dla propozycji projektów** ⬜ — propozycja `create_project` (v1.5) ma
  `project_id=NULL, scope='global'`, więc w przełączniku kontekstu wisi pod „Global” obok pamięci
  globalnych. Osobny filtr / widok propozycji projektów. Odłożone z v1.5 (2026-10-05): na start
  wystarcza istniejący filtr typu.

> Auto mode per projekt → zrobione w v1.6 (zastąpił dawne „Auto-allow po N spójnych decyzjach",
> patrz „Wycięte").

## Auth i dostęp

- **Per-user auth** ⬜ — + kontrola dostępu per-projekt dla człowieka. Następny krok po tokenie konta
  z v1.5: token konta staje się tokenem konkretnego usera, a „wszystkie projekty instancji" zawęża się
  do projektów, do których user ma dostęp.
- **Token tylko do odczytu** ⬜ — token (konta albo projektowy) ograniczony do `search_memory` /
  `get_memory`. Token konta to klucz do wszystkich projektów, a CI czy mniej zaufany agent zwykle
  potrzebuje tylko odczytu. Naturalnie łączy się z per-user auth (uprawnienia per user/projekt).
- **Rewokacja sesji** ⬜ — świadomie odłożone w review bezpieczeństwa v1.1.
- **Pamięć usera** ⬜ — osobny scope na pamięć o konkretnym użytkowniku, widoczną tylko dla niego.
  **Zablokowane na per-user auth** wyżej — bez tożsamości człowieka nie ma czego zawęzić; osobny token
  to tylko obejście, nie tożsamość.

## Skalowanie / interop

- **Skalowanie poziome** ⬜ — rate-limiter na Redis (dziś in-memory, per-instancja), praca wielo-instancyjna.
- **Interop wire-format** ⬜ — wspólny format wymiany pamięci.
- **Bulk-import dokumentów** ⬜.
- **Chunk-targeted `get`** ⬜ — pobranie konkretnego fragmentu dokumentu zamiast całości.

## Dashboard / UI

Z przeglądu UX 2026-10-12: przejście apki w przeglądarce (lokalna instancja z danymi dev) + przegląd
kodu wszystkich ekranów. Każda pozycja sprawdzona w źródle, oznaczone **(E2E)** odtworzone w
przeglądarce. Ścieżki względem `apps/dashboard/src/`. Zmiany układu, nowe sekcje i komponenty
zaczynają się od specu w [`design-system.md`](design-system.md) (§12).

> Bugi z przeglądu (akord `g ‹litera›`, skrót `A` na `stale`, klik w „Tagi", ładowanie Audytu,
> niewidoczny slug, globalny `:focus-visible`), przełącznik projektów ze znakiem projektu
> (`ProjectAvatar`) i ikona aplikacji → w v1.8 ([`roadmap.md`](roadmap.md)).

### Stany błędu, sesja, zdrowie instancji

- **Błąd ładowania wygląda jak „pusto"** ⬜ — listy nie czytają `isError`: przy błędzie serwera
  Kolejka pokazuje „Inbox zero", inne ekrany „Brak pamięci / zdarzeń / projektów / tokenów / danych"
  (Kolejka, Pamięć, Oś czasu, Projekty, `TokenManager`, Audyt, Pomiary); nieudany refetch zostawia
  starą listę bez ostrzeżenia. §10 wymaga błędu inline z „Ponów" — wzorzec już jest w Ustawieniach.
- **Wieczny skeleton w detalu propozycji** ⬜ — gdy pobranie pamięci „przed" / źródeł merge się nie
  uda, `!beforeMemory` trzyma skeleton bez końca (`screens/QueueScreen.tsx`); recenzent nie może
  zdecydować. Użyć bloku „pamięć niedostępna" jak w B3.
- **Wygaśnięcie sesji w trakcie pracy** ⬜ — brak globalnej obsługi 401: listy robią się puste,
  akcje dają tylko toast, ekran logowania pojawia się dopiero przy kolejnym sprawdzeniu sesji (do
  60 s) i wtedy zrzuca niezapisane formularze (`lib/api.ts`, `lib/query.ts`, `hooks/useSession.ts`).
- **Pasek zdrowia ukrywa problemy** ⬜ — „Nocny job" pokazuje ✓ także po nieudanym przebiegu (Backup
  sprawdza `failed`, nocny job nie); brak kafla `secret_blocked`/24h z §9.0 (`secretBlocked24h` jest
  w typach, nie jest renderowany); brak czasu ostatniego przebiegu / backupu (tooltip)
  (`components/AppShell.tsx`).

### Kolejka: klawiatura, fokus, czytelność

- **`j`/`k` wyprowadza zaznaczenie poza ekran** ⬜ — brak `scrollIntoView` gdziekolwiek w SPA.
- **Niewidoczny fokus na wierszach** ⬜ — `focus-visible:outline-none` bez ringu w `ProposalRow` i
  wierszu przeglądarki pamięci; nawigacja Tabem nie pokazuje pozycji (§10). Wzorzec ringu jest w
  `OsCzasuScreen`.
- **Po zatwierdzeniu/odrzuceniu zaznaczenie skacze na pierwszy wiersz** ⬜ — zamiast na następny;
  fokus ginie razem z odmontowanym przyciskiem.
- **Wiersze nocnego jobu nie do odróżnienia** ⬜ **(E2E)** — tytuł wiersza propozycji `delete` to
  „Archiwizacja pamięci mem_…" (ucięty przed ID), nagłówek pamięci widać dopiero w detalu
  (`rowTitle` w `screens/QueueScreen.tsx`). Serwerowy `summary` powinien nieść nagłówek celu.
- **Prune po wieku bez powodu** ⬜ **(E2E)** — detal pokazuje samo przekreślenie; uzasadnienie ma
  tylko prune z LLM (`rationale`). Dopisać powód recency („nieużywana od N dni").
- **Teksty** ⬜ — żargon w toaście („pamięć zmaterializowana"), angielskie etykiety (zakładka
  „Body", filtry `approved/archived/purged`), niejasne „acc N" na liście pamięci (§11).

### Dialogi i utrata pracy

- **Dialogi destrukcyjne zamykają się od razu** ⬜ — `AlertDialogAction` bez `preventDefault`
  (Hard-purge, Odrzuć, bulk approve/reject, Archiwizuj): stanu „Wymazywanie…" nie widać, a przy
  błędzie wpisany powód przepada. Poprawnie robi to `AutoModeUndoDialog`.
- **Jednorazowy token można zgubić** ⬜ — okno „pokazujemy raz" zamyka się na Esc i klik obok, akord
  `g ‹litera›` też je zamyka (`components/TokenReveal.tsx`); kopiowanie po samym http cicho zawodzi.
  Zamykać tylko przez „Zapisałem token".
- **Niezapisane zmiany przepadają bez pytania** ⬜ — „Nowa pamięć" (Esc / klik obok / ✕, także
  wklejony dokument), „Anuluj" w edycji pamięci, formularz Ustawień przy nawigacji; dialog
  potwierdzenia w Pamięci pyta nawet, gdy nic się nie zmieniło. Flaga „dirty".
- **„Zatwierdź jako zamiennik" bez potwierdzenia** ⬜ — pierwszy klik w liście kandydatów od razu
  supersede'uje; wyszukiwanie bez debounce i bez obsługi błędu, starsza odpowiedź nadpisuje nowszą
  (`components/ProposalActions.tsx`). Wzorzec jest w `RelationsPanel`.
- **„Promuj do global" bez potwierdzenia** ⬜ — akcja widoczna we wszystkich projektach.
- **Dialog rotacji tokena** ⬜ — zepsute zdanie („zostanie wydany na jeszcze") sugerujące natychmiastową
  podmianę wbrew okresowi karencji, czerwony (destrukcyjny) przycisk, zamyka się przed końcem
  requestu (`components/TokenManager.tsx`).

### Stan w URL i nawigacja

- **Filtry poza URL** ⬜ — Kolejka (origin/type), Pamięć (kind/status/zatwierdzenie/tagi/q), Audyt
  (filtry + doczytane strony), Pomiary (zakres/bucket/projekt) trzymają filtry w stanie lokalnym;
  odświeżenie albo „wstecz" (np. po skoku z `DedupHint` do `/pamiec?id=`) je kasuje. `useSearchParams`.
- **Audyt: „Zarządzaj tokenem →" otwiera tylko listę Projektów** ⬜ — §9.4 chce dialogu tokenów
  danego projektu (`/projekty?tokens=<id>`).
- **Paleta ⌘K** ⬜ — wyniki błędu jako „Brak wyników", brak akcji (Nowa pamięć, motyw, ściągawka);
  debounce → pozycja „⌘K: debounce + indeks" w długu technicznym niżej.

### Układ i wąskie okno

- **Wąskie okno rozjeżdża aplikację** ⬜ **(E2E)** — przy 1024 px w Kolejce tytuły ucinają się do
  „A…", cała strona dostaje poziomy scroll, a „Zatwierdź jako zamiennik" wypada poza ekran. Rail
  240 px i search 280 px się nie zwijają, pasek akcji się nie zawija, tabela Projektów ucina kolumny.
  Zmiana układu → najpierw spec (§9.0, §9.1): rail zwijany do ikon poniżej `lg`, `flex-wrap` paska
  akcji, `overflow-x-auto` tabel.

### Drobne i dostępność

- **Dostępność** ⬜ — etykiety tylko z placeholdera (filtry tagów i szukania w Pamięci, daty w
  Audycie), selektor `kind` w „Nowa pamięć" bez `aria-pressed`/radiogroup, drop-zone bez roli i
  `tabIndex`, `aria-selected` na `role=button` w `ProposalRow`, nazwa przycisku odświeżania to
  „2 min temu", nazwa przycisku motywu różni się od widocznego tekstu.
- **Skróty mało odkrywalne** ⬜ — podpowiedź `⌘K` także na Windows, brak widocznego wejścia do
  ściągawki i podpowiedzi skrótów na pozycjach railu (§10).
- **Drobne poprawki ekranów** ⬜ — `DedupHint` w „Nowa pamięć" ma martwe linki i copy „propozycja i
  tak powstała" (tu żadnej nie ma); Onboarding: blok env miesza `setx` i `export` w jednym kopiowaniu
  (dwa bloki), przy błędzie „Odśwież stronę" bez przycisku; nieudany podgląd purge nic nie pokazuje,
  a purge dalej jest dozwolony; wylogowanie bez obsługi błędu.
- **Zepsute polskie znaki w danych** ⬜ — w danych dev jest „za�o�ony" (najpewniej zapis testowy z
  PowerShella w złym kodowaniu); serwer przyjmuje U+FFFD bez ostrzeżenia. Do zbadania: czy
  `save_memory` / create powinny ostrzegać albo odrzucać.
- **Pomiary: zieleń na zieleni** ⬜ — po zmianie akcentu na zieleń znaku (v1.8, „Ikona aplikacji")
  `--info` jest tą samą zielenią co `--primary`, więc w `components/UsageChart.tsx:187-188` seria
  „Zaakceptowane z edycją" (`var(--info)`) stoi stackowana na „Zaakceptowane" (`var(--success)`) —
  dwie zielenie jedna na drugiej. To samo w `lib/usage-chart.ts` (`PROJECT_PALETTE`): `var(--primary)`
  tuż obok `var(--success)`, a `var(--primary-hover)` (szósty) ≈ `var(--primary)`. Rozwiązać razem z
  paletą `ProjectAvatar` (v1.8, [`roadmap.md`](roadmap.md)), która też musi ominąć zielony akcent.
- **Dryf neutrali: `design-system.md` §2.1 / §7.1 vs `globals.css`** ⬜ — kod ma rozciągniętą rampę
  neutralnych (rewizja kontrastu z v1.3, komentarz w `globals.css`), spec dalej stare wartości: kanwa
  `#FAFAF9` / `#141312` w specu vs `#F2F0ED` / `#121110` w kodzie, a poza nią m.in. `surface` (dark
  `#1B1A18` vs `#1E1C1A`), `surface-muted`/`muted`, `border`, `border-strong`, `text-faint`,
  `neutral-subtle`. Przepisać §2.1 i §7.1 z `globals.css` (kod jest źródłem prawdy).

## Dług techniczny / architektura

Z przeglądu technicznego 2026-07-29 → [`tech-review.md`](tech-review.md) (tam objawy z dowodami
`plik:linia`, tu jednolinijkowce). Wagi: 🟠 będzie boleć · 🟢 higiena.

> Wszystkie cztery pozycje 🔴 („boli teraz") → zrobione w v1.4. `GET /api/proposals` bez `LIMIT` (#5)
> i audyt per projekt (#7) → zrobione w v1.6 („Nocny job na skali"). Vitest w
> dashboardzie, test throttlingu logowania i test `surface.middleware` (#11–#13) → zrobione w v1.7
> („Luki w testach z przeglądu technicznego",
> [`archive/roadmap-2026-10-12-v1.7-complete.md`](archive/roadmap-2026-10-12-v1.7-complete.md)).

- **⌘K: debounce + indeks `memories(updated_at)`** ⬜ 🟠 — request na każdy klawisz, `ILIKE '%q%'` i
  sort po nieindeksowanej kolumnie. Koszt M.
- **Jedna implementacja archiwizacji** ⬜ 🟠 — dwie kopie w `ProposalsService` i `MemoryAdminService`,
  już rozjechane (różne `via`, snapshot bez `eventTime`). Koszt M.
- **Wspólny zapis embeddingów** ⬜ 🟠 — to samo mapowanie chunków w 7 miejscach, jedno z innym polem.
  Koszt M.
- **Parytet enumów SPA ↔ serwer** ⬜ 🟠 — `types/domain.ts` nie zna `'withdrawn'`; potrzebny test
  wymuszający, nie tylko jednorazowa poprawka. Koszt S.
- **`pnpm audit` jako bramka** ⬜ 🟢 — advisory react-router jest u nas niewykorzystywalne (SPA bez
  RSC), ale blokuje wpięcie audytu do `verify`; wyciszyć z uzasadnieniem. Koszt S.
- **Porządek w devDeps dashboardu** ⬜ 🟢 — pluginy ESLint zadeklarowane bez `eslint`; usunięcie
  „nieużywanych" psuje `lint`. Koszt S.

---

## Wycięte

Nie „odłożone" — świadoma decyzja, że tego nie robimy. Zostaje tu ze śladem „dlaczego", żeby temat nie
wracał co przegląd.

- **Memory Worth** (2026-07-27) — prune po współwystąpieniu z sukcesem / porażką (`report_outcome` +
  tabela `outcome`). Sygnał outcome jest z natury zaszumiony (sesja się udała ≠ ta pamięć pomogła),
  a koszt to nowe narzędzie MCP wymagające zdyscyplinowanego użycia przez agenta — najgorszy stosunek
  wartości do złożoności w całym backlogu. Score w rankingu jest pluggable, więc temat wraca, jeśli
  pojawi się realny sygnał.
- **Auto-allow po N spójnych decyzjach** (2026-10-03) — zastąpione przez jawny przełącznik auto mode
  per projekt (v1.6). Heurystyka „po N zgodnych decyzjach" zgadywała, kiedy recenzent przestał być
  potrzebny; przy wielu repo właściciel wie to sam i woli zdecydować wprost per projekt. Kolumny
  `confidence` / `auto_eligible` w schemie zostają — mogą się przydać przy auto mode.
