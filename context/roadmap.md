# Context Keeper — Roadmapa

Prosty przegląd: co robimy po kolei i gdzie jesteśmy. Szczegóły → [`prd.md`](prd.md), [`tech-stack.md`](tech-stack.md), [`design-system.md`](design-system.md).

**Aktualizacja:** 2026-07-27 · **Etap:** v1.2 domknięte (możliwości agenta + UI) → wchodzimy w **v1.3** (dostęp i UI).

Legenda: ✅ zrobione · 🔨 w toku · ⬜ przed nami

> Pełne opisy zakresu faz 0 → v1.2 zarchiwizowane w
> [`archive/roadmap-2026-07-27-v1.2-complete.md`](archive/roadmap-2026-07-27-v1.2-complete.md).
> Wcześniejszy snapshot (v1 domknięte): [`archive/roadmap-2026-07-23-v1-complete.md`](archive/roadmap-2026-07-23-v1-complete.md).

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

- **Seed pamięci grounding-dokumentami** — wdrożona instancja zaseedowana stabilnymi dokumentami przez CLI `seed-memory`, żeby `search_memory` miał co zwracać.
- **Instrumentacja użycia pamięci** — ekran „Pomiary" (`/pomiary`) na tabeli `search_events`: liczba wyszukań, rate zerowych wyników, stosunek accept/reject/edit.
- **Dashboard: ręczny trigger nocnego jobu + hard-purge** — ekran „Operacje" (`/operacje`) plus purge per-pamięć z podglądem skali i wymaganym powodem.
- **Review bezpieczeństwa publicznego MCP** — pre-auth throttle per-IP na `/mcp`, `helmet` + CSP, bind portów compose do `127.0.0.1`, czysty audit zależności.

### v1.2 — Więcej możliwości agenta + poprawki UI

- **`kind=event` (episodic)** — trzeci rodzaj wpisu z backdatable `event_time`, age-decay w rankingu, ekran „Oś czasu" i per-projektowy toggle widoczności w domyślnym search.
- **memory-relations + 1-hop graph boost** — typowane krawędzie (`caused_by`/`follows`/`context_for`) tworzone przez agenta i człowieka, z re-rank-only boostem na sąsiadach.
- **Edycja `event_time` po utworzeniu** — korekta backdate’u z formularza edycji w przeglądarce pamięci.
- **Agent tworzy `kind=document`** — `save_memory` przyjmuje opcjonalny `kind` (`fact` | `document`) przy tych samych guardach; `event` pozostaje human-only.
- **Edycja pamięci przez agenta** — `save_memory` z `supersedes: id` proponuje in-place korektę własnej pamięci jako proposal `type='update'` zamiast luźnego duplikatu.
- **Snippet do wklejenia w cudzym projekcie** — ekran „Onboarding" z gotowymi blokami do `AGENTS.md` / `CLAUDE.md` i `.mcp.json`, z URL-em MCP liczonym server-side.
- **Poprawki UI** — dopieszczenie dashboardu wg design systemu.

---

## v1.3 — Dostęp i UI 🔨

**Cel fazy:** domknąć zarządzanie dostępem (wiele agentów per projekt bez downtime przy rotacji),
uczytelnić dashboard tam, gdzie dogfooding pokazał realne tarcie, oraz dołożyć agentowi ostatni brakujący
rodzaj wpisu — wraz z fixem deduplikacji, który ten trzeci rodzaj czyni pilnym.

### Dostęp

- **Wiele tokenów per projekt + graceful rotation** ✅ — `project_tokens` (1 projekt → N tokenów,
  etykieta WYMAGANA per token) zamiast trzech kolumn tokena na `projects`. Rotacja jest token-scoped
  i graceful: nowy token wydany obok starego, stary wchodzi w `grace` i wygasa lazily po
  `TOKEN_GRACE_PERIOD_HOURS` (domyślnie 72h) — bez nocnego sweepu, ta sama reguła auth i UI. Osobna
  akcja `revoke` (natychmiastowa, nieodwracalna) dla skompromitowanych danych. Atrybucja per-agent:
  `search_events.token_id` + `audit_log.metadata.{tokenId,tokenLabel}` (actor pozostaje
  `agent:<projectId>`), rate limiting per-token zamiast per-projekt.

### Agent / MCP

- **`kind=event` przez agenta (MCP)** ⬜ — zniesienie ograniczenia human-only: `save_memory` przyjmuje
  `kind: "event"` wraz z `event_time`. Te same guardy co dla `fact`/`document` (human-gate, skaner
  sekretów, limity rozmiaru). Do rozstrzygnięcia w projektowaniu: czy `event_time` jest wymagane, czy
  domyślnie „teraz", i jak szeroki backdate wolno zaproponować agentowi.
- **Dedup kind-aware** ✅ — **fix znanego buga, nie feature.** `computeContentHash` i zapytania
  `already_exists`/`duplicate_pending` w `MemoryService.save()` niosą teraz `kind` jako piąte pole
  hasha (`header ␟ body ␟ scope ␟ project ␟ kind`) — identyczny `header`+`body` zapisany jako różne
  `kind` (np. `fact` i `document`) to od teraz ODRĘBNA pamięć, nie duplikat. Migracja przeliczyła
  istniejące `proposals.content_hash` na nową formułę. Nocny job (`dedup-cluster.ts`) dostał defense-
  in-depth: ANN-partycja i `pickCanonicalMerge` też są ścisłe po `kind` (nieosiągalne dziś — oba końce
  ANN są już `kind='fact'` — ale zabezpiecza przed przyszłym rozszerzeniem skanu).

### UI

- **Widok diff dla `supersedes`** ✅ — case `update` w `DiffView` renderuje teraz word-level inline
  diff (jsdiff `diffWords`, `apps/dashboard/src/lib/text-diff.ts`) zamiast dwóch pełnych bloków
  tekstu obok siebie: niezmienione słowa zwykłym tekstem, usunięcia pod `<del>`, dodania pod `<ins>`,
  legenda `−/+` nad blokiem. Ten sam renderer dla nagłówka i treści. Cztery fallbacki z typowanym
  powodem: `'too-long'` (>20 000 znaków) i `'aborted'` (jsdiff timeout 250 ms) to twarde limity
  wydajności bez obejścia; `'too-different'` (>70% treści zmienione) to heurystyka czytelności —
  recenzent może ją obejść linkiem „Pokaż zmiany inline mimo to"; `'whitespace-only'` (czysty
  reflow/wcięcie, brak zmian słów) pokazuje notkę zamiast pustego podświetlenia. Wszystkie fallbacki
  renderują dawny układ dwóch bloków `del`/`add`. A11y: `<del>`/`<ins>` (nie kolor sam w sobie),
  `role="group"`/`aria-label` na kontenerze (§10 design-systemu).
- **Czytelność przeglądarki pamięci** ✅ — panel szczegółów zajmuje teraz całą dostępną wysokość
  (poprawiony bug CSS: `auto`-wiersz grida przeciekał poza `main`, więc to strona scrollowała się
  w całości zamiast paneli listy/treści); treść scrolluje się wewnętrznie, a pasek akcji
  (Edytuj/Archiwizuj/Promuj/Hard-purge, w edycji: Zapisz/Anuluj) jest przyklejony na dole i zawsze
  widoczny. Nagłówek/meta/zakładki/akcje dzielą jedną kolumnę pomiaru (`max-w-4xl`), a szerokość
  czytania treści zależy od `kind` (`document` 72ch, `fact`/`event` 66ch).
- **Wydzielić zakładkę Projekty** ✅ — `NAV_ITEMS` (`apps/dashboard/src/components/AppShell.tsx`)
  rozbite na 7 ekranów kontekstowych + osobny `PROJECTS_NAV_ITEM`, renderowany w dolnej sekcji railu
  (przy toggle motywu i „Wyloguj", odcięty `border-t`) zamiast wśród reszty nawigacji — bo dotyczy
  ustawień całego projektu, nie wybranej pamięci. Wspólny `railNavLinkClass`/`RailNavLink` trzyma
  identyczne active-state styling w obu miejscach renderowania.
- **Przenieść wybór projektu do sidebara** ✅ — `ContextSwitcher` przeniesiony z top bara do railu
  (pod marką, nad „Nawigacja"); trigger rozciągnięty na pełną szerokość (`h-9 w-full`, label
  `flex-1 truncate`). Top bar zostaje z samym search (poszerzony `w-[280px]`) i health strip.
- **Bulk approve/reject w kolejce** ✅ — zaznaczanie wielu propozycji (checkbox per-wiersz + „zaznacz
  wszystkie" w pasku filtrów, skrót `x`) i jedna decyzja na cały zaznaczony zestaw, zamiast klikania
  pozycja po pozycji. NIE jest „czysto UI" (korekta wcześniejszego zapisu) — dwa nowe endpointy-
  orkiestratory (`POST /proposals/bulk-approve`/`bulk-reject`, `ProposalsService.bulkApprove`/
  `bulkReject`) wołają sekwencyjnie NIETKNIĘTE `approve()`/`reject()` per id. Inwariant, który się
  liczy, zostaje: każda pojedyncza decyzja nadal przechodzi dokładnie tę samą transakcję i ten sam
  audit trail co dotychczas, human-gate nietknięty. Bulk NIE jest atomowy (częściowy sukces to
  decyzja produktowa — porażka jednego itemu nie cofa wcześniejszych sukcesów), cap `BULK_MAX_IDS=100`;
  po operacji sukcesy znikają z zaznaczenia, porażki zostają zaznaczone (dialog ze szczegółami per id).
  Wydzielone z „anti-fatigue kolejki" w backlogu — druga połowa tamtego punktu (auto-allow po N
  spójnych decyzjach) tam zostaje, bo rozmiękcza human-gate.

## Backlog ⬜

Rzeczy świadomie odłożone poza v1.3 → [`backlog.md`](backlog.md): plugin Claude Code (warunkowy), OAuth 2.1
+ PKCE, migracja na MCP SDK v2, tuning retrievalu, `conflicts_report`, auto-allow w kolejce, per-user auth,
pamięć usera, rewokacja sesji, lepszy prune w nocnym jobie, skalowanie poziome / interop.

**Wycięte** (nie „odłożone"): Memory Worth — prune po współwystąpieniu z sukcesem/porażką. Sygnał outcome
jest z natury zaszumiony (sesja się udała ≠ ta pamięć pomogła), a koszt to nowe narzędzie MCP wymagające
zdyscyplinowanego użycia przez agenta. Score w rankingu jest pluggable, więc temat wraca, jeśli pojawi się
realny sygnał — na razie nie zajmuje miejsca w backlogu.
