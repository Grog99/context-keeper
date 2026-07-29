# Context Keeper — Backlog

Rzeczy świadomie odłożone poza bieżącą wersję. Nie są porzucone — czekają na decyzję albo na sygnał
z danych (część jest **warunkowa**). Aktywny plan i to, co robimy teraz → [`roadmap.md`](roadmap.md).

**Aktualizacja:** 2026-07-29 (wieczór) · przy otwarciu v1.4 do [`roadmap.md`](roadmap.md) poszły:
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
- **OAuth 2.1 + PKCE dla MCP** ⬜ — dla klientów Desktop / web-connector. **Uwaga:** nowa specyfikacja
  MCP (2026-07-28) zaostrza wymagania wokół auth (walidacja issuera, `application_type` w Dynamic
  Client Registration, scope accumulation, credential binding) — projektować od razu pod te
  wymagania, nie pod stary model.
- **Migracja na nowy standard MCP / SDK v2** ⏸️ — spec z 2026-07-28 wprowadza m.in. stateless
  architecture (bez handshake `initialize`), MRTR (`InputRequiredResult` w trakcie wywołania) i
  standaryzację kodów błędów JSON-RPC. TS SDK v2 jest **ESM-only** (Node 20+, split na
  `@modelcontextprotocol/server`/`client`, Standard Schema) — realny koszt w naszym CommonJS-owym
  NestJS (`apps/server`), nie coś do zrobienia przy okazji. Bety zachowują kompatybilność wsteczną
  z v1 SDK, brak twardego terminu wymuszającego zmianę. Nasz transport MCP jest już bezstanowy
  (Faza 2, `StreamableHTTPServerTransport` bez sesji) — kierunek nowej specyfikacji już pasuje do
  architektury. **Warunkowe:** wracamy do tematu, gdy SDK v2 się ustabilizuje albo pojawi się
  konkretna potrzeba (np. przy OAuth wyżej).

## Retrieval i higiena pamięci

- **Tuning retrievalu na realnych danych** ⬜ — top-k, próg relevance, próg dedup, `k` RRF, chunking
  (PRD §11). Karmi się instrumentacją z Pomiarów — pomiar najpierw, dostrojenie potem.

> `conflicts_report` i „lepszy prune w nocnym jobie" → [`roadmap.md`](roadmap.md), v1.4 (dzielą skan
> i mały model, więc idą razem).

## Kolejka akceptacji

- **Auto-allow po N spójnych decyzjach** ⬜ — `confidence` / `auto_eligible` w schemie już gotowe.
  Zostaje w backlogu świadomie: rozmiękcza human-gate, czyli rdzeń produktu, a przy jednym recenzencie
  nie ma jeszcze zmęczenia, które miałby leczyć. Bulk approve/reject — druga połowa dawnego punktu
  „anti-fatigue kolejki" — poszło do v1.3 ([`roadmap.md`](roadmap.md)), bo nie dotyka gate'u.

## Auth i dostęp

- **Per-user auth** ⬜ — + kontrola dostępu per-projekt dla człowieka.
- **Rewokacja sesji** ⬜ — świadomie odłożone w review bezpieczeństwa v1.1.
- **Pamięć usera** ⬜ — osobny scope na pamięć o konkretnym użytkowniku, widoczną tylko dla niego.
  **Zablokowane na per-user auth** wyżej — bez tożsamości człowieka nie ma czego zawęzić; osobny token
  to tylko obejście, nie tożsamość.

## Skalowanie / interop

- **Skalowanie poziome** ⬜ — rate-limiter na Redis (dziś in-memory, per-instancja), praca wielo-instancyjna.
- **Interop wire-format** ⬜ — wspólny format wymiany pamięci.
- **Bulk-import dokumentów** ⬜.
- **Chunk-targeted `get`** ⬜ — pobranie konkretnego fragmentu dokumentu zamiast całości.

## Dług techniczny / architektura

Z przeglądu technicznego 2026-07-29 → [`tech-review.md`](tech-review.md) (tam objawy z dowodami
`plik:linia`, tu jednolinijkowce). Wagi: 🟠 będzie boleć · 🟢 higiena.

> Wszystkie cztery pozycje 🔴 („boli teraz") → [`roadmap.md`](roadmap.md), v1.4.

- **`GET /api/proposals` bez `LIMIT`** ⬜ 🟠 — pełne payloady jsonb, polling co 15 s, `?status=approved`
  zwraca całą historię. Koszt M.
- **⌘K: debounce + indeks `memories(updated_at)`** ⬜ 🟠 — request na każdy klawisz, `ILIKE '%q%'` i
  sort po nieindeksowanej kolumnie. Koszt M.
- **Audyt per projekt: GIN na `affected_ids`** ⬜ 🟠 — nieograniczony fetch id pamięci + `&&` bez
  indeksu; koszt rośnie iloczynem rozmiarów. Koszt M.
- **Jedna implementacja archiwizacji** ⬜ 🟠 — dwie kopie w `ProposalsService` i `MemoryAdminService`,
  już rozjechane (różne `via`, snapshot bez `eventTime`). Koszt M.
- **Wspólny zapis embeddingów** ⬜ 🟠 — to samo mapowanie chunków w 7 miejscach, jedno z innym polem.
  Koszt M.
- **Parytet enumów SPA ↔ serwer** ⬜ 🟠 — `types/domain.ts` nie zna `'withdrawn'`; potrzebny test
  wymuszający, nie tylko jednorazowa poprawka. Koszt S.
- **Vitest w `apps/dashboard`** ⬜ 🟠 — brak skryptu `test` czyni `pnpm verify` server-only; bez
  pokrycia zostaje `computeInlineWordDiff` z czterema progami. Koszt M.
- **Test throttlingu logowania** ⬜ 🟠 — jedyna bariera przed brute-force współdzielonego hasła,
  nietestowana (fallback IP, kolejność throttle vs sprawdzenie hasła). Koszt S.
- **Test `surface.middleware`** ⬜ 🟠 — granica portów MCP/dashboard bez ani jednego testu; regresja
  wystawia `/api/*` na publicznym porcie. Koszt S.
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
