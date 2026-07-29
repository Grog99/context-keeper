# Context Keeper — Roadmapa

Prosty przegląd: co robimy po kolei i gdzie jesteśmy. Szczegóły → [`prd.md`](prd.md), [`tech-stack.md`](tech-stack.md), [`design-system.md`](design-system.md).

**Aktualizacja:** 2026-07-29 · **Etap:** v1.3 domknięte (dostęp i UI) → wchodzimy w **v1.4** (higiena pamięci + dług techniczny).

Legenda: ✅ zrobione · 🔨 w toku · ⬜ przed nami

> Pełne opisy zakresu faz 0 → v1.3 zarchiwizowane w
> [`archive/roadmap-2026-07-29-v1.3-complete.md`](archive/roadmap-2026-07-29-v1.3-complete.md).
> Wcześniejsze snapshoty: [v1.2](archive/roadmap-2026-07-27-v1.2-complete.md) ·
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

---

## v1.4 — Higiena pamięci i dług techniczny 🔨

**Cel fazy:** dołożyć nocnemu jobowi drugą połowę roli proposera — dziś umie deduplikować, ale nie umie
ani sensownie przycinać, ani zauważyć sprzeczności — spłacić dług „boli teraz" z pierwszego przeglądu
technicznego i domknąć kolejkę akceptacji tam, gdzie recenzent decyduje bez kompletu informacji.

### Higiena pamięci (nocny job)

- **Lepszy prune w nocnym jobie** ⬜ — mały model przegląda wpisy z ostatniego dnia i proponuje
  usunięcie albo skrócenie tego, co niepotrzebne. **Nie nowy podsystem** — heurystyka w istniejącym
  kroku `prune`, który już jest proposerem i już trafia do kolejki akceptacji. (z backlogu)
- **`conflicts_report`** ⬜ — wykrywanie sprzeczności same-topic w nocnym jobie (sąd LLM). Adresuje
  przypadek, którego `supersedes` nie łapie: „nikt nie zauważył, że koryguje istniejący fakt".
  Naturalnie dzieli infrastrukturę z prune wyżej (ten sam skan, ten sam mały model), stąd razem w
  jednej fazie. (z backlogu)

### Dług techniczny 🔴

Cztery pozycje „boli teraz" z [`tech-review.md`](tech-review.md); pełne objawy z dowodami `plik:linia`
tam, tu zakres.

- **`Set-Cookie` sesji w logach produkcyjnych** ⬜ — `redact` w `app.module.ts` obejmuje tylko stronę
  żądania, więc domyślny serializer pino loguje wszystkie nagłówki odpowiedzi, w tym ciasteczko sesji.
  Koszt S.
- **Walidacja runtime query-paramów `/api`** ⬜ — gołe `@Query()` dają 500 zamiast 400 przy złym
  `kind`/`limit`/`from`; zod jest już zależnością. Koszt M.
- **`/health` bez limitu na publicznym porcie MCP** ⬜ — `SELECT 1` + fetch do TEI na każdy request,
  bez cache i bez throttlingu, na porcie wystawionym publicznie. Koszt S.
- **`Intl.RelativeTimeFormat` zamiast ręcznej drabinki** ⬜ — `format.ts` renderuje „1 dni temu" dla
  24–35 h i nie ma górnego progu. Koszt S.

### UI

- **Tagi i `kind` w kolejce akceptacji** ⬜ — recenzent podejmuje decyzję bez dwóch pól, które
  propozycja niesie: nie widzi tagów ani rodzaju wpisu. Domyka serię „kolejka pokazuje to, co
  zatwierdzasz", zaczętą w v1.3 wyświetleniem `event_time`. (z backlogu)

## Backlog ⬜

Rzeczy świadomie odłożone poza v1.4 → [`backlog.md`](backlog.md): plugin Claude Code (warunkowy), OAuth 2.1
+ PKCE, migracja na MCP SDK v2, tuning retrievalu, auto-allow w kolejce, per-user auth, pamięć usera,
rewokacja sesji, skalowanie poziome / interop, oraz pozostały dług techniczny 🟠/🟢 z przeglądu
([`tech-review.md`](tech-review.md)).

**Wycięte** (nie „odłożone"): Memory Worth — prune po współwystąpieniu z sukcesem/porażką. Sygnał outcome
jest z natury zaszumiony (sesja się udała ≠ ta pamięć pomogła), a koszt to nowe narzędzie MCP wymagające
zdyscyplinowanego użycia przez agenta. Score w rankingu jest pluggable, więc temat wraca, jeśli pojawi się
realny sygnał — na razie nie zajmuje miejsca w backlogu.
