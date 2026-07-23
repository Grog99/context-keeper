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
- **OAuth 2.1 + PKCE dla MCP** ⬜ — dla klientów Desktop / web-connector.

## Retrieval i higiena pamięci

- **Tuning retrievalu na realnych danych** ⬜ — top-k, próg relevance, próg dedup, `k` RRF, chunking
  (PRD §11). Karmi się instrumentacją z Pomiarów — pomiar najpierw, dostrojenie potem.
- **`conflicts_report`** ⬜ — wykrywanie sprzeczności same-topic w nocnym jobie (sąd LLM).
- **Memory Worth** ⬜ — prune po współwystąpieniu z sukcesem / porażką (`report_outcome` + tabela
  `outcome`; score jest już pluggable).

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
