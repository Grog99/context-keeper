# Context Keeper — Roadmapa

Prosty przegląd: co robimy po kolei i gdzie jesteśmy. Szczegóły → [`prd.md`](prd.md), [`tech-stack.md`](tech-stack.md), [`design-system.md`](design-system.md).

**Aktualizacja:** 2026-07-22 · **Etap:** planowanie zamknięte (spec v1.2), wchodzimy w implementację.

Legenda: ✅ zrobione · 🔨 w toku · ⬜ przed nami

---

## Faza 0 — Planowanie i design ✅

- [x] Research prior-art (`research-prior-art-pamiec-agentow.md`)
- [x] Plan pamięci agentów MCP (`plan-pamiec-agentow-mcp.md`)
- [x] PRD v1.2 (`prd.md`)
- [x] Tech-stack i architektura v1.2 (`tech-stack.md`)
- [x] Design system + klikalna makieta (`design-system.md`, `design-system-mockup.html`)

## v1 — Rdzeń (budujemy teraz)

**1. Fundament** ✅
Host NestJS (adapter Express). Postgres + pgvector, Docker Compose, model danych (schema), projekty + bearer tokeny (`ck_`, hash). Reverse proxy opcjonalny (profil `edge-proxy` bundled Caddy / bring-your-own-proxy).

**2. MCP server** ✅
3 narzędzia: `search_memory` / `get_memory` / `save_memory`. Auth per token → scope, taksonomia błędów, rate-limiting, skaner sekretów przy save. Transport Streamable HTTP bezstanowy; `search` FTS-only (wektor + RRF → Faza 3); kontrakt narzędzi w `mcp-tool-contract.md`.

**3. Retrieval** ⬜
Hybrid: wektor + full-text, fuzja RRF, dwufazowy (nagłówki → body). Abstrakcja providera embeddingów + presety deploy-time (`multilingual`/`english`/`api`, CLI `reembed`) + degradacja fail-open (FTS-only).

**4. Kolejka akceptacji** ⬜
Tabela `proposals`, transakcyjne zatwierdzanie, optimistic concurrency (stale = blokada), edit-before-approve, supersession.

**5. Dashboard** ⬜
4 ekrany (kolejka / przeglądarka pamięci / projekty+tokeny / audyt) + przełącznik kontekstu + human-create (fakty, dokumenty, import `.md`). Wg design systemu.

**6. Nocny job** ⬜
Proposer (nie executor): dedup / merge / prune → do tej samej kolejki. Advisory lock, idempotentny re-scan.

**7. Utwardzenie** ⬜
Audit log, observability (`/health`, metryki), backup (`pg_dump` + offsite), testy rdzenia (transakcja akceptacji, scope/IDOR, skaner sekretów).

**8. Onboarding / instalator** ⬜
`install.sh` — generacja `.env` + sekrety + wybór profili (preset embeddingów, tryb proxy); uruchomienie stacku opcjonalne (prompt). Kanon configu = `.env.example`.

## v1.1 — Zaraz po rdzeniu ⬜

- Plugin Claude Code (config połączenia + skill proaktywności)
- Dashboard: ręczny trigger nocnego jobu + hard-purge

## v2 i dalej ⬜ (backlog)

`kind=event` (episodic) · `conflicts_report` · Memory Worth (prune po outcome) · anti-fatigue kolejki · per-user auth · edycja pamięci przez agenta · OAuth 2.1 + PKCE.
