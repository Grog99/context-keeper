# Context Keeper — Backlog

Rzeczy świadomie odłożone poza bieżącą wersję. Nie są porzucone — czekają na decyzję albo na sygnał
z danych (część jest **warunkowa**). Aktywny plan i to, co robimy teraz → [`roadmap.md`](roadmap.md).

**Aktualizacja:** 2026-07-23 · wydzielone z roadmapy przy wejściu w v1.2.

Legenda: ⬜ przed nami · ⏸️ warunkowe (czeka na sygnał / decyzję)

---

## Agent / MCP

- **Plugin Claude Code** ⏸️ — bundle: config połączenia + skill proaktywności („Warstwa 3" kontraktu
  narzędzi). **Warunkowy:** budujemy tylko, jeśli instrumentacja (ekran Pomiary) pokaże, że czysty
  MCP + `AGENTS.md` nie wymuszają proaktywnego recallu. v1.2 najpierw wyciska maksimum z samego MCP.
- **Wiele tokenów per projekt + graceful rotation** ⬜ — atrybucja per-agent, rotacja bez downtime.
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
- **`conflicts_report`** ⬜ — wykrywanie sprzeczności same-topic w nocnym jobie (sąd LLM).
- **Memory Worth** ⬜ — prune po współwystąpieniu z sukcesem / porażką (`report_outcome` + tabela
  `outcome`; score jest już pluggable).
- **Dedup kind-aware** ⬜ — `computeContentHash`/`already_exists` w `MemoryService.save()` dziś ignorują
  `kind`: identyczny `header`+`body` zapisany jako różne `kind` (np. `fact` i `document`) koliduje jako
  duplikat, drugi zapis ginie po cichu (`duplicate_pending`/`already_exists` wskazuje na pamięć
  niewłaściwego rodzaju). Świadomie odłożone przy "Agent tworzy `kind=document`" (v1.2) — znane
  ograniczenie udokumentowane komentarzem w kodzie i w opisie narzędzia `save_memory`.

## Kolejka akceptacji

- **Anti-fatigue kolejki** ⬜ — bulk approve/reject, auto-allow po N spójnych decyzjach
  (`confidence` / `auto_eligible` w schemie już gotowe).

## Auth i dostęp

- **Per-user auth** ⬜ — + kontrola dostępu per-projekt dla człowieka.
- **Rewokacja sesji** ⬜ — świadomie odłożone w review bezpieczeństwa v1.1.

## Skalowanie / interop

- **Skalowanie poziome** ⬜ — rate-limiter na Redis (dziś in-memory, per-instancja), praca wielo-instancyjna.
- **Interop wire-format** ⬜ — wspólny format wymiany pamięci.
- **Bulk-import dokumentów** ⬜.
- **Chunk-targeted `get`** ⬜ — pobranie konkretnego fragmentu dokumentu zamiast całości.

## UI

- **Poprawić widok diff dla supersedes** - W tym momencie cięzko zobaczyć co się zmieniło, spróbować
  zrobić widok diff jak w git aby widać było dokładniej zmiany
- **Poprawić widok pamięci** - jest teraz mało czytelny gdy wszystko jest w odcieniach szarości. Dodatkowo
  widok rekordu powinien zajmować całą dostępną powierzchnię zamiast połowy. Może dodać scroll w widoku
  rekordu i przykleić przyciski Edytuj, Archiwizuj itd na dole żeby zawsze było widać.
- **Przenieść zakładkę projekty** - Niech będzie widocznie oddzielna jako że odnosi się do ustawień całego projektu a nie wybranego.
- **Przenieść wybór projektu** - Niech wybór projektu będzie w bocznym pasku nad nawigacją, pod logo, będzie dzieki temu bardziej widocczne
  w którym jesteśmy.
 
## Do zastanowienia się

- **Dodać pamiec usera** - oddzielny token dla pamięci o konkretnym użytkowniku, wtedy takie zapiski pamieci może widzieć tylko dany user.
- **Optymalizacja zapisów w pamięci** - mały model który sprawdza pliki pamięci z ostatniego dnia w ramach nigthly
  i sprawdza czy wszystko co jest zapisane na pewno jest potrzebne, czy można usunąć treść
