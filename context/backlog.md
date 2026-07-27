# Context Keeper — Backlog

Rzeczy świadomie odłożone poza bieżącą wersję. Nie są porzucone — czekają na decyzję albo na sygnał
z danych (część jest **warunkowa**). Aktywny plan i to, co robimy teraz → [`roadmap.md`](roadmap.md).

**Aktualizacja:** 2026-07-27 · pełny przegląd przy wejściu w v1.3. Do [`roadmap.md`](roadmap.md) poszły:
wiele tokenów + rotacja, cała sekcja UI, dedup kind-aware, bulk approve/reject. Memory Worth wycięte
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
- **`conflicts_report`** ⬜ — wykrywanie sprzeczności same-topic w nocnym jobie (sąd LLM). Priorytet w dół
  po v1.2: `supersedes` (agent + człowiek) adresuje konflikt **na wejściu**, więc to dopala już tylko
  przypadek „nikt nie zauważył, że koryguje istniejący fakt".
- **Lepszy prune w nocnym jobie** ⬜ — mały model przegląda wpisy z ostatniego dnia i proponuje usunięcie
  lub skrócenie tego, co niepotrzebne. **Nie nowy podsystem** — heurystyka w istniejącym kroku `prune`
  nocnego jobu, który już jest proposerem i już trafia do kolejki akceptacji.

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

---

## Wycięte

Nie „odłożone" — świadoma decyzja, że tego nie robimy. Zostaje tu ze śladem „dlaczego", żeby temat nie
wracał co przegląd.

- **Memory Worth** (2026-07-27) — prune po współwystąpieniu z sukcesem / porażką (`report_outcome` +
  tabela `outcome`). Sygnał outcome jest z natury zaszumiony (sesja się udała ≠ ta pamięć pomogła),
  a koszt to nowe narzędzie MCP wymagające zdyscyplinowanego użycia przez agenta — najgorszy stosunek
  wartości do złożoności w całym backlogu. Score w rankingu jest pluggable, więc temat wraca, jeśli
  pojawi się realny sygnał.
