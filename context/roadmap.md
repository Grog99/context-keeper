# Context Keeper — Roadmapa

Prosty przegląd: co robimy po kolei i gdzie jesteśmy. Szczegóły → [`prd.md`](prd.md), [`tech-stack.md`](tech-stack.md), [`design-system.md`](design-system.md).

**Aktualizacja:** 2026-07-23 · **Etap:** v1 domknięte i wdrożone (dogfooding live) → wchodzimy w **walidację** (v1.1).

Legenda: ✅ zrobione · 🔨 w toku · ⬜ przed nami

> Poprzedni snapshot (stan „v1 domknięte", przed reconcile) zarchiwizowany w
> [`old/roadmap-2026-07-23-v1-complete.md`](old/roadmap-2026-07-23-v1-complete.md).

---

## Faza 0 — Planowanie i design ✅

- [x] Research prior-art (`old/research-prior-art-pamiec-agentow.md`)
- [x] Plan pamięci agentów MCP (`old/plan-pamiec-agentow-mcp.md`)
- [x] PRD v1.2 (`prd.md`)
- [x] Tech-stack i architektura v1.2 (`tech-stack.md`)
- [x] Design system + klikalna makieta (`design-system.md`, `design-system-mockup.html`)

## v1 — Rdzeń ✅ (ukończone)

**1. Fundament** ✅
Host NestJS (adapter Express). Postgres + pgvector, Docker Compose, model danych (schema), projekty + bearer tokeny (`ck_`, hash). Reverse proxy opcjonalny (profil `edge-proxy` bundled Caddy / bring-your-own-proxy).

**2. MCP server** ✅
3 narzędzia: `search_memory` / `get_memory` / `save_memory`. Auth per token → scope, taksonomia błędów, rate-limiting, skaner sekretów przy save. Transport Streamable HTTP bezstanowy; kontrakt narzędzi w `mcp-tool-contract.md`.

**3. Retrieval** ✅
Hybrid: wektor + full-text, fuzja RRF, dwufazowy (nagłówki → body). Abstrakcja providera embeddingów + presety deploy-time (`multilingual`/`english`/`api`, CLI `reembed`) + degradacja fail-open (FTS-only).

**4. Kolejka akceptacji** ✅
Tabela `proposals`, transakcyjne zatwierdzanie, optimistic concurrency (stale = blokada), edit-before-approve, supersession.

**5. Dashboard** ✅
4 ekrany (kolejka / przeglądarka pamięci / projekty+tokeny / audyt) + przełącznik kontekstu + human-create (fakty, dokumenty, import `.md`). Wg design systemu.

**6. Nocny job** ✅
Proposer (nie executor): dedup / merge / prune → do tej samej kolejki. Advisory lock, idempotentny re-scan. Ręczny trigger jako CLI `run-nightly`.

**7. Utwardzenie** ✅
Audit log, observability (`/health`, metryki — w tym latencja embeddingu, FR-D7/NFR-4), backup (`pg_dump` + offsite, audit event `backup_completed` przez CLI `record-backup`), testy rdzenia (transakcja akceptacji, scope/IDOR, skaner sekretów). Hard-purge jako CLI `purge`.

**8. Onboarding / instalator** ✅
`install.sh` — generacja `.env` + sekrety + wybór profili (preset embeddingów, tryb proxy); uruchomienie stacku opcjonalne. Kanon configu = `.env.example`.
- Ścieżka PaaS (Coolify): build z repo przez `deploy/docker-compose.coolify.yml` (auto-migracja
  in-process), runbook [`docs/deploy-coolify.md`](../docs/deploy-coolify.md). Coolify Scheduled Tasks
  zastępują host-cron dla nocnego joba i `infra/backup.sh`.

**Dogfooding** ✅ — repo używa własnej wdrożonej instancji jako pamięci projektu (MCP `context-keeper`, config w `.mcp.json`, kontrakt w `AGENTS.md`).

---

## v1.1 — Walidacja dogfoodingu 🔨

**Cel fazy:** sprawić, by eksperyment „czy **sam MCP + kontrakt narzędzi + `AGENTS.md`** wystarczą, żeby
agent proaktywnie sięgał do pamięci" był **mierzalny** i **miał realną treść do znalezienia**. Dopiero
wynik tej fazy decyduje, czy plugin Claude Code jest potrzebny (patrz backlog).

- **Seed pamięci grounding-dokumentami** ✅ — zaseeduj wdrożoną instancję stabilnymi dokumentami
  (`design-system.md`, `mcp-tool-contract.md`, kluczowe decyzje jako `kind=document`) przez istniejące
  CLI `seed-memory`. Bez treści `search_memory` zwraca zero i eksperyment nie ma czego znaleźć.
- **Instrumentacja użycia pamięci** ✅ — ekran „Pomiary" (`/pomiary`): liczba `search_memory`/projekt
  w czasie, searche z **0 wyników** (rate), stosunek accept/reject/edit propozycji. Nowa tabela
  `search_events` (zapis fail-open w `search()`), endpoint `GET /api/metrics/usage`, wykresy recharts.
  Warstwa, na której podejmiemy decyzję o pluginie na danych, nie na oko.
- **Dashboard: ręczny trigger nocnego jobu + hard-purge** — wystawienie w UI istniejących CLI
  `run-nightly` i `purge` (mała robota, domyka pozycje przesunięte z v1).
- **Review bezpieczeństwa publicznego MCP** ✅ — pass utwardzający po token-gated endpoincie. Auth,
  scope/IDOR i redakcja tokenu potwierdzone bez dziur; wdrożone utwardzenia: throttle **pre-auth
  per-IP** na `/mcp` przed `BearerGuard` (`RATE_LIMIT_MCP_IP_PER_MIN`), `helmet` + CSP + `x-powered-by`
  off, eviction bucketów in-memory, override `@hono/node-server` (audit czysty), bind portów compose do
  `127.0.0.1` (DB/dashboard poza publicznym interfejsem), `limit_req` w przykładzie nginx. Świadomie
  odłożone: rewokacja sesji, limiter na Redis (v2).

## v2 i dalej ⬜ (backlog)

- **Plugin Claude Code** (config połączenia + skill proaktywności) — **warunkowy:** budujemy tylko,
  jeśli instrumentacja z v1.1 pokaże, że czysty MCP + `AGENTS.md` nie wymuszają proaktywnego recallu.
- **Tuning retrievalu na realnych danych** — top-k, próg relevance, próg dedup, `k` RRF, chunking
  (PRD §11). Karmi się instrumentacją z v1.1 — pomiar najpierw, dostrojenie potem.
- **`kind=event` (episodic)** — zdarzenia z czasem, age-decay, memory-relations + 1-hop graph boost, timeline.
- **`conflicts_report`** — wykrywanie sprzeczności same-topic w nocnym jobie (sąd LLM).
- **Memory Worth** — prune po współwystąpieniu z sukcesem/porażką (`report_outcome` + tabela `outcome`; score już pluggable).
- **Anti-fatigue kolejki** — bulk approve/reject, auto-allow po N spójnych decyzjach (`confidence`/`auto_eligible` w schemie gotowe).
- **Per-user auth** + kontrola dostępu per-projekt dla człowieka.
- **Edycja pamięci przez agenta** (`supersedes: id`), agent-proposed edycje dokumentów, **wiele tokenów per projekt** + graceful rotation (atrybucja agenta).
- **OAuth 2.1 + PKCE** dla MCP (Desktop/web-connector).
- Interop wire-format; bulk-import dokumentów; chunk-targeted `get`; skalowanie poziome (rate-limiter na Redis).
