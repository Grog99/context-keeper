# Context Keeper — PRD (Product Requirements Document)

**Produkt:** współdzielona, trwała pamięć dla agentów AI (Claude i inni) wystawiona jako remote MCP server.
**Wersja dokumentu:** v1.2 (Faza 1 + ustalenia przedimplementacyjne + domknięcia stacku) · **Data:** 2026-07-22
**Źródła:** `plan-pamiec-agentow-mcp.md`, `research-prior-art-pamiec-agentow.md`, sesja ustaleń przedimplementacyjnych

> Ten dokument opisuje **co** budujemy i **dlaczego**. Decyzje implementacyjne (schema SQL, transport, stack) są w [`tech-stack.md`](tech-stack.md).

---

## 0. Changelog

### v1.2 — domknięcia stacku

1. Framework hosta wybrany: **NestJS** (adapter Express). → §4, §11 (domknięte)
2. **Presety embeddingów** deploy-time (`multilingual`/`english`/`api`) — wybór modelu, w tym lekki EN-only. → §4, §11 (domknięte)
3. **Reverse proxy opcjonalny** — bundled Caddy albo bring-your-own-proxy (homelab). → §4, §7 NFR
4. **Instalator onboardingu** (`install.sh`, generacja `.env` + sekrety, uruchomienie opcjonalne) w zakresie v1. → §4, §5

### v1.1 — ustalenia przedimplementacyjne

Uzupełnienia z sesji domykania planu przed kodem (wpięte in-place):

1. Kontrakt z agentem 3-warstwowy (opisy MCP + snippet `CLAUDE.md`/`AGENTS.md` w v1 + plugin v1.1). → §4, §6.1
2. Degradacja embeddingów fail-open + twardy budżet czasu na `save`. → §7, §8
3. Współbieżność kolejki — optimistic concurrency, stale = blokada + badge. → §6.2
4. Human-create + import `.md` + przełącznik kontekstu (`Wszystkie`/`Global`/projekt). → §4, §5, §6.4
5. Dedup advisory + supersession human-mediated („Zatwierdź jako zamiennik"). → §6.1, §6.4
6. Auth klienta MCP zweryfikowany (bearer wystarcza; OAuth → roadmapa). → §8, §10
7. Limity wejścia + normalizacja tagów. → §6.6
8. Skaner sekretów + hard-purge + `secret_blocked` jako sygnał rotacji. → §6.6, §7
9. Taksonomia błędów MCP + hash-idempotencja. → §6.1
10. Semantyka operacyjna nocnego jobu. → §6.5
11. Token `ck_` + SHA-256, rotacja hard-cutover. → §7
12. Oficjalny MCP SDK. → §4
13. Strategia testów skupiona na rdzeniu. → §9

---

## 1. Streszczenie

Context Keeper to samodzielna aplikacja (self-hosted) pełniąca rolę **czystej, autorytatywnej pamięci** dla agentów AI. Agenci łączą się przez remote MCP, wyszukują kontekst do zadań i proponują zapis nowych faktów. Kluczowa cecha: **żadna treść nie trafia do pamięci bez zatwierdzenia przez człowieka** (human-gated writes). Dashboard służy do przeglądu, edycji i akceptacji, a nocny job **proponuje** (nie wykonuje) porządki: dedup, merge, prune.

**Zasada przewodnia:** prosto w v1, ale schema i architektura gotowe na rozszerzenia.

**Pozycjonowanie:** narzędzie osobiste/zespołowe + nauka, nie produkt rynkowy. Wzorzec (*Co-memorize diff-and-approve* / Governed Memory) jest zwalidowany przez prior-art, ale nasza nisza to pełna kombinacja: remote MCP + scope przez credential + pełna bramka akceptacji + nocny proposer + dwufazowy retrieval + dashboard, self-hosted zespołowo.

---

## 2. Problem i uzasadnienie

Agenci AI tracą kontekst między sesjami i między sobą. Istniejące systemy pamięci albo:
- zapisują **autonomicznie** (Mem0, doobidoo) → ryzyko zaśmiecenia i cichego skasowania wiedzy (udokumentowany incydent: autonomiczna konsolidacja zarchiwizowała po cichu 76+ pozycji), albo
- są **solo-local** (ipiton, adamrdrew) → brak trybu zespołowego / remote.

Efekt: brak jednego, **zaufanego** źródła prawdy, do którego wielu agentów w wielu projektach może sięgać, mając pewność, że nic błędnego ani zatrutego tam nie weszło bez wiedzy człowieka.

**Dlaczego bramka akceptacji jest wartością, nie tylko kosztem:** zatruta lub błędna pamięć musi przejść przez człowieka, zanim wpłynie na przyszłe sesje. To czyni architekturę odporniejszą na memory-poisoning (rank-0 injection) niż systemy autonomiczne.

---

## 3. Użytkownicy

| Rola | Kto | Potrzeba |
|---|---|---|
| **Recenzent / właściciel pamięci** | człowiek (start: 1 osoba, docelowo zespół) | przeglądać i zatwierdzać zapisy, edytować, tworzyć dokumenty, promować do `global`, utrzymać czystość store'u |
| **Agent piszący** | Claude / inny agent AI z tokenem projektu | zapisać nowo poznany fakt (jako propozycję), nie czekając na człowieka |
| **Agent czytający** | j.w. | znaleźć kontekst do zadania (fakty + dokumenty) w swoim projekcie + `global` |

**Model użytkowników v1:** brak kont per-user w aplikacji. Dashboard za wspólnym auth aplikacji (współdzielone hasło + sesja, za VPN/proxy). Per-user auth to v2.

**Skala:** kilka projektów, sporo dokumentów, kilku agentów jednocześnie miejscami.

**Warunek żywotności v1:** cała wartość stoi na tym, że **jeden recenzent nadąża zatwierdzać**. v1 zakłada wolumen zapisów mieszczący się w przepustowości jednego człowieka; powyżej tego potrzebny anti-fatigue (auto-allow — v2).

---

## 4. Zakres

### 4.1 W zakresie v1 (in-scope)

- **Remote MCP server** (oficjalny `@modelcontextprotocol/sdk`) z 3 narzędziami: `search_memory`, `get_memory`, `save_memory`.
- **Scope pamięci:** `global` | `project`; projekt wyznaczany przez credential (token per projekt), nie przez argument agenta.
- **Pełna kolejka akceptacji** — każda treściowa mutacja to `proposal`; nic nie wchodzi do pamięci bez akceptacji. **Optimistic concurrency** (stale = blokada + badge).
- **Dwa rodzaje pamięci (`kind`):** `fact` (fakty accreted przez agenta, mutowalne) i `document` (dokumenty authored przez człowieka: PRD, roadmap — kanon, permanentne; w v1 human-only).
- **Hybrid retrieval** — wektor + full-text, fuzja RRF, dwufazowy (nagłówki → pełne body); FTS-only fallback przy embedding-down.
- **Dashboard** (4 ekrany) + **przełącznik aktywnego kontekstu** (`Wszystkie`/`Global`/projekt) + **human-create** (tworzenie faktów i dokumentów, import `.md`).
- **Nocny job** jako **proposer** — proponuje dedup/merge/prune; lock, idempotentne re-propose, samosprzątanie stale.
- **Soft-delete** (`archived`), nigdy hard-delete — z awaryjnym **hard-purge CLI** (sekrety/PII).
- **Bezpieczeństwo treści:** skaner sekretów przy save (agent=block, human=warn), limity/walidacja wejścia.
- **Audit log** append-only, **rate limiting** per-token, **taksonomia błędów** MCP.
- **Kontrakt z agentem:** opisy narzędzi MCP (pełny kontrakt) + snippet do `CLAUDE.md`/`AGENTS.md`.
- **Deployment configurable przy wdrożeniu:** preset embeddingów (`multilingual` domyślny / `english` lekki EN-only / `api`) + tryb reverse proxy (bundled Caddy / bring-your-own-proxy dla homelaba). Szczegóły w [`tech-stack.md`](tech-stack.md) §7, §9.
- **Instalator onboardingu:** interaktywny `install.sh` generujący `.env` + sekrety + wybór profili Compose; uruchomienie stacku opcjonalne (prompt, default = tylko generacja). Nie zastępuje 12-factor env — kanonem zostaje `.env.example`.

### 4.2 Poza zakresem v1 (out-of-scope → v2 / v1.1)

- **Plugin Claude Code** (bundle config + skill) → **v1.1**; ręczny trigger nocnego jobu i hard-purge w dashboardzie → **v1.1**.
- `kind=event` (episodic) z age-decay i grafem relacji.
- Aktualizacja/edycja istniejących pamięci przez agenta (v1: agent tylko `create`); agent-proposed edycje dokumentów.
- `conflicts_report` (wykrywanie sprzeczności same-topic, ewentualnie z weryfikacją AI).
- Konta per-user w dashboardzie / kontrola dostępu per-projekt dla człowieka.
- Wiele tokenów per projekt (rozróżnianie agentów; graceful rotation z nakładką).
- **OAuth 2.1 + PKCE** dla MCP (Desktop/web-connector); v1 = statyczny bearer (zweryfikowany).
- Anti-fatigue: bulk approve/reject, auto-allow po N spójnych decyzjach.
- **Memory Worth** (prune po sukcesie/porażce zadania) — wymaga kanału outcome.
- Twarda multi-tenancy; hot-swap providera embeddingów per-request; live-update kolejki (v1: polling); bulk-import dokumentów; chunk-targeted `get`.

---

## 5. Przypadki użycia

**UC-1 — Agent zapisuje fakt.** Agent poznaje fakt → `save_memory` → system liczy embedding + dedup (z twardym budżetem czasu) → zwraca `{id, status: "pending"}` bez czekania na człowieka. Fakt niewidoczny dla search do akceptacji.

**UC-2 — Agent szuka kontekstu.** `search_memory(query, tags?, kind?)` → tanie nagłówki (`fact`+`document`) ze scope z tokena → triage → `get_memory(id)` po pełne body.

**UC-3 — Recenzent zatwierdza zapis.** Człowiek widzi `pending` proposal z diffem zależnym od typu → akceptuje / odrzuca / edytuje-przed-akceptacją / **zatwierdza jako zamiennik [X]** (supersession). Akceptacja transakcyjnie materializuje pamięć; stale proposal jest zablokowany + oznaczony badge.

**UC-4 — Recenzent utrzymuje store.** Człowiek edytuje pamięć, archiwizuje, promuje do `global`, zmienia `scope`/`kind` — commit bezpośredni + `revision`.

**UC-5 — Recenzent tworzy dokument / fakt ręcznie.** W aktywnym kontekście (projekt lub `Global`) człowiek tworzy nową pamięć (`New memory`: `fact`/`document`), wkleja treść lub importuje `.md`. `project_id`/`scope` wyprowadzane z kontekstu; commit bezpośredni (`source=human`).

**UC-6 — Nocny job proponuje porządki.** Job skanuje `fact`, wykrywa duplikaty/staleness → wrzuca propozycje do tej samej kolejki (filtr `origin=nightly`), pomijając duplikaty i sprzątając własne stale. Człowiek zatwierdza jak zwykły zapis.

**UC-7 — Zarządzanie projektami/tokenami.** Człowiek tworzy projekt (z pierwszym, etykietowanym bearer tokenem `ck_…`, widocznym raz, w bazie hash), dodaje kolejne tokeny dla kolejnych agentów (etykieta wymagana), rotuje token pojedynczego agenta (graceful — nowy obok starego, stary wygasa po okresie karencji, reszta agentów nietknięta) albo unieważnia go natychmiast (skompromitowany credential), i zmienia etykietę istniejącego tokena (v1.3).

**UC-8 — Agent próbuje zapisać sekret.** Skaner wykrywa sekret → save zablokowany (`secret_blocked` actionable error), audit `secret_blocked` (metadane: typ sekretu + który token/agent, v1.3) → operator widzi sygnał w dashboardzie i **rotuje albo unieważnia wyciekły credential TEGO agenta**, bez wpływu na pozostałe tokeny projektu.

---

## 6. Wymagania funkcjonalne (FR)

### 6.1 Interfejs MCP

- **FR-M1** `search_memory(query, tags?, kind?)` → `[{id, header, tags, score}]`. Scope z tokena. Domyślnie `fact`+`document`; opcjonalny filtr `kind`. Dla `document` excerpt dopasowanego chunku. Przy embedding-down → **FTS-only** (ciche).
- **FR-M2** `get_memory(id)` → pełne body; bumpuje `last_accessed_at`/`access_count`. **Egzekwuje scope**; poza scope **lub** nieistniejące → identyczne **`not_found`** (anty-probing IDOR).
- **FR-M3** `save_memory(header, body, tags)` → proposal, `{id, status}`. Embedding + dedup z **twardym budżetem czasu** (po timeoucie `pending` bez embeddingu, doembed przy akceptacji). **Dedup advisory:** twardy `duplicate_pending` tylko exact-match do pending; exact do approved → `already_exists`; **podobne → proposal zawsze powstaje + hint** (embedding nie odróżnia korekty od duplikatu).
- **FR-M4** Zapisy agenta **tylko project-scoped**. Promocja do `global` = akcja człowieka.
- **FR-M5** Agent w v1 tylko **tworzy** (`create`). Korekta faktu = nowy `create` + human-mediated supersession.
- **FR-M6** Auth: statyczny bearer token per projekt w `Authorization`; serwer mapuje token → `project_id`. **Zweryfikowany dla Claude Code**; OAuth → roadmapa.
- **FR-M7** **Taksonomia błędów:** błędy wykonania narzędzia → `isError` + koperta `{code, message}` (`validation_error`/`secret_blocked`/`not_found`); transport/auth → HTTP (`401`, `429`+`Retry-After`). `code` stabilne.
- **FR-M8** **Idempotencja:** exact `hash(header+body+scope+project+kind)` → `duplicate_pending` (pending) / `already_exists` (approved). Bez client idempotency key w v1.
- **FR-M9** **Kontrakt z agentem:** opisy narzędzi niosą pełny kontrakt (co/czego nie zapisywać, human-gate, jeden fakt/zapis, semantyka zwrotki); load-bearing polityka (w tym „nie zapisuj sekretów") jedzie z serwerem, nie z pluginem/wklejką. Snippet proaktywności → `CLAUDE.md`/`AGENTS.md`.

### 6.2 Kolejka akceptacji (write path)

- **FR-Q1** Każda treściowa mutacja (`create`/`update`/`merge`/`delete`) przechodzi przez tabelę `proposals`.
- **FR-Q2** Zatwierdzenie **aplikuje zmianę transakcyjnie** (row-lock na dotknięte pamięci); odrzucone zostają do audytu.
- **FR-Q3** Pending żyje tylko w `proposals` → search (materialized memories) widzi tylko `approved`.
- **FR-Q4** Bramka wg **origin**: `source=agent`/`nightly` → kolejka; `source=human` → commit bezpośredni + `revision`.
- **FR-Q5** Zapisy techniczne (`access_count`, `last_accessed_at`) idą bezpośrednio, z pominięciem kolejki.
- **FR-Q6** Edit-before-approve: recenzent zmienia header/body przed akceptacją; commit odzwierciedla edycję, oryginalny payload zostaje w proposalu („approved with edits") + `revision` + re-embed.
- **FR-Q7** **Optimistic concurrency:** proposal na istniejące pamięci zapisuje `base_versions`; przy akceptacji sprawdzane w transakcji. Drift → **stale** (blokada + badge), człowiek decyduje/aktualizuje. Podwójna akceptacja rozwiązuje się sama.
- **FR-Q8** **Supersession (human):** „Zatwierdź jako zamiennik [X]" = approve new + archive old + link w `revisions`/`audit`.

### 6.3 Retrieval

- **FR-R1** Rozdzielenie: search **zwraca** nagłówki, ale **dopasowuje** po header + body.
- **FR-R2** Hybrid: wektor (semantyka, fleksja PL/EN) + full-text (dokładne tokeny techniczne). Fuzja RRF.
- **FR-R3** Wektor na chunkach, FTS na całym dokumencie; **collapse** grupuje chunki po `memory_id` przed fuzją.
- **FR-R4** Top-k + próg relevance. Tagi: filtr strukturalny + tekst dopisany do embeddingu.
- **FR-R5** Search zawęża wektory do aktywnego modelu embeddingów.

### 6.4 Dashboard

- **FR-D1 Kolejka akceptacji:** `pending` proposale, filtr po `origin`/`type`. Diff zależny od typu. Edit-before-approve; **„Zatwierdź jako zamiennik [X]"**; stale = blokada + badge z powodem.
- **FR-D2 Przeglądarka pamięci:** `approved`/`archived`, filtry: `scope`, `kind`, tagi, status. Detal z metadanymi, `access_count`/`last_accessed_at`, historią `revisions`. Akcje człowieka = commit bezpośredni + `revision`.
- **FR-D3 Projekty/tokeny:** CRUD projektów; **wiele bearer tokenów per projekt** (v1.3, etykieta wymagana — atrybucja per-agent), każdy widoczny raz przy tworzeniu. **Rotacja graceful** (token-scoped: nowy obok starego, stary wygasa po okresie karencji konfigurowalnym env-em, pozostałe tokeny projektu nietknięte) + **unieważnienie natychmiastowe** (osobna akcja, dla skompromitowanych danych) + rename etykiety. Żyje poza przełącznikiem kontekstu (lista wszystkich).
- **FR-D4 Audyt:** odrzucone proposale + przegląd `revisions` + filtrowalne eventy (m.in. **`secret_blocked`**, `purge_tombstone`).
- **FR-D5 Human-create:** akcja „Nowa pamięć" (`fact`/`document`), pola `header`/`body`/`kind`/`tags`; `scope`/`project_id` wyprowadzane z aktywnego kontekstu. Import: **wklejka + upload `.md`** (bez bulk). Opcjonalnie miękkie „similar existing memories".
- **FR-D6 Przełącznik aktywnego kontekstu:** `Wszystkie` | `Global` | projekt — cała aplikacja dziedziczy. `Wszystkie` = zunifikowany inbox recenzenta (create wyłączony). Widok projektu **strict** (tylko pamięci projektu; global to osobny kontekst).
- **FR-D7 Metryki w dashboardzie:** głębokość kolejki, latencja/zdrowie embeddingu, wynik nocnego jobu, **liczba blokad skanera sekretów / 24h**.

### 6.5 Nocny job

- **FR-N1** **Proposer, nie executor** — wyniki do `proposals` z diffem.
- **FR-N2** Działa **tylko na `kind=fact`**.
- **FR-N3** Skanuje wszystko, **scala wąsko** — tylko przy prawdziwym pokryciu tego samego tematu.
- **FR-N4** Dedup przez ANN (near-neighbors), nie O(n²). Prune z `last_accessed_at`/`access_count` + minimalny wiek/grace.
- **FR-N5** **Semantyka operacyjna:** advisory lock (single-instance); stateless idempotentny re-scan (bez checkpointów); **samosprzątanie** — pomija równoważny ważny pending, withdraw własnych stale + re-derive; dotyka wyłącznie własnych nightly-proposali.
- **FR-N6** Harmonogram konfigurowalny (domyślnie ~03:00 lokalnie); **ręczny trigger CLI** `run-nightly` (dashboard → v1.1); event `nightly_run` (status + liczniki).

### 6.6 Walidacja i bezpieczeństwo treści

- **FR-V1 Limity wejścia:** `header` ~200 zn. jednolinijkowy; `body` per `kind` (`fact` ~8 KB / `document` ~256 KB); `tags` max ~10, ≤ ~40 zn., **normalizacja** (trim + lowercase + collapse whitespace). Naruszenie → `validation_error`.
- **FR-S1 Skaner sekretów przy save:** wąski wysokosygnałowy zestaw (private keys, klucze chmur, JWT/bearer, `password=`, entropia). **Agent → blokada** (`secret_blocked`, bez echa sekretu, sekret nie dotyka bazy); **human → ostrzeżenie** (treść nie mutowana). PII nie skanujemy w v1. Bez redakcji w locie.
- **FR-S2 `secret_blocked` = sygnał rotacji/unieważnienia:** audit event z metadanymi (typ sekretu + `tokenId`/`tokenLabel` (v1.3, atrybucja per-agent) + czas, bez materiału) → operator rotuje albo unieważnia wyciekły credential TEGO konkretnego tokena (LLM już go przeczytał — blokada nie un-exposuje).
- **FR-S3 Hard-purge:** uprzywilejowane CLI `purge <id> --reason` wymazujące treść we wszystkich content-bearing tabelach + `purge_tombstone` w audycie. Nie wystawiony przez MCP; nie łamie zasady soft-delete (archive = domyślna ścieżka). Dashboard → v1.1.

---

## 7. Wymagania niefunkcjonalne (NFR)

- **NFR-1 Kontrola dostępu na odczyt.** Read w MCP filtrowany tokenem; `get_memory` egzekwuje scope (IDOR → `not_found`). Dashboard read = bez ograniczeń (zaufany człowiek).
- **NFR-2 Audit log.** Append-only, zdarzenia zmieniające stan (z aktorem, czasem, referencją do `revision`), w tym `secret_blocked`, `purge_tombstone`, `nightly_run`. Odczyty nie per-event — liczniki.
- **NFR-3 Rate limiting.** Per-token (od v1.3 dosłownie per bearer token, nie per projekt — N agentów per projekt dostają N niezależnych budżetów), ostrzej na `save_memory`; `429` + `Retry-After`.
- **NFR-4 Observability.** Structured logs na stdout, `/health` (embedding-down = degraded, nie unhealthy), minimalne metryki w dashboardzie (§6.4 FR-D7).
- **NFR-5 Trwałość / backup.** Jedna baza = jedno źródło prawdy (wektory w dumpie). `pg_dump` na cronie + kopia offsite, retencja N dni.
- **NFR-6 Retencja `archived`.** Soft-delete nigdy nie kasuje wiersza; `archived` żyją bezterminowo, ale embeddingi kasowane (nie wyszukiwalne). Wyjątek = hard-purge (sekrety/PII).
- **NFR-7 Prywatność danych.** Możliwość pełnego offline (embeddingi lokalne) — treść nie musi opuszczać hosta.
- **NFR-8 Degradacja.** Fail-open na obu ścieżkach: `save` zawsze tworzy proposal (autorytatywny embedding przy akceptacji), `search` leci FTS-only.
- **NFR-9 Bezpieczeństwo tokenu.** Token `ck_` + 256-bit; w bazie SHA-256 (indeksowany, bez pepper). **Rotacja graceful od v1.3** (nowy token obok starego, stary wygasa lazily po okresie karencji — zastępuje hard-cutover z v1) + **unieważnienie natychmiastowe** jako osobna akcja dla skompromitowanych danych.

---

## 8. Świadome trade-offy i założenia

| Trade-off | Świadoma akceptacja |
|---|---|
| **Miękka izolacja** (metadana + filtr, nie twarda multi-tenancy) | Wyciek tokenu = pełny odczyt i zapis projektu. Mitygacja (v1.3) = rotacja (graceful) albo unieważnienie (natychmiastowe) TEGO konkretnego tokena — inne tokeny/agenci projektu nietknięci. |
| **Cross-agent latency** | Fakt agenta A niewidoczny dla agenta B (ten sam projekt) do akceptacji. Stan sesji ma żyć w kontekście agenta. |
| **Async ack (fire-and-forget)** | Fakt zapisany w kroku 1 nie będzie znaleziony przez search w kroku 5 tej samej sesji (pending). |
| **Przepustowość akceptacji** | v1 zakłada, że jeden recenzent nadąża. Powyżej — anti-fatigue (v2). |
| **Audyt per-agent od v1.3** | Rozwiązane: wiele tokenów per projekt (`project_tokens`, etykieta wymagana) + atrybucja `audit_log.metadata.{tokenId,tokenLabel}`/`search_events.token_id`. `actor` pozostaje `agent:<project_id>` (nie per-token) — filtr projektu w `AuditService.query` niezmieniony. |
| **Provider/preset embeddingów zablokowany per deployment** | Wybór presetu (`multilingual`/`english`/`api`) to decyzja deploy-time; zmiana modelu = re-embed wszystkiego (CLI `reembed`), nie tani runtime-swap. Preset `english` (EN-only) szybszy/lżejszy, ale ryzykowny przy treści mieszanej PL/EN → `multilingual` domyślny. |
| **Dedup advisory** | Podobne zapisy nie są auto-suppressowane (bo embedding nie odróżnia korekty od duplikatu) → nieco więcej duplikatów w kolejce; czyści człowiek/nocny job. |
| **Statyczny bearer (nie OAuth)** | Zweryfikowany dla klientów header-configurable (Claude Code/Cursor/SDK). Desktop/web-connector (OAuth) → roadmapa. |
| **Degradacja embeddingów** | Przy providerze down: save bez dedup-hint (możliwy przejściowy duplikat), search bez recall semantycznego (FTS-only). |

---

## 9. Kryteria sukcesu

- **Czystość store'u:** 0 treściowych zapisów, które weszły do pamięci bez akceptacji człowieka.
- **Znajdywalność:** `recall@k` na małym labelowanym zestawie `zapytanie → oczekiwane memory_id` (smoke-test regresji).
- **Przepustowość recenzenta:** głębokość kolejki stabilna w czasie (metryka w dashboardzie).
- **Brak cichych utrat wiedzy:** każdy `archive`/`merge`/`delete` ma ślad w audycie i możliwość odtworzenia z `revisions`.
- **Adopcja:** agent realnie sięga do pamięci zamiast pytać od zera (rosnący `access_count`).
- **Higiena sekretów:** wykryte sekrety nie wchodzą do store'u; każda blokada → sygnał rotacji dla operatora.

**Strategia testów** (skupiona na rdzeniu, nie pełne pokrycie — szczegóły [`tech-stack.md`](tech-stack.md) §15): priorytet 1 = transakcja akceptacji + optimistic-concurrency; priorytet 2 = scope/IDOR; dalej skaner sekretów, nocny job, retrieval, `recall@k`, cienki MCP e2e (zarazem smoke łączności bearer).

---

## 10. Roadmapa (v1.1, v2 i dalej)

**v1.1 (zaraz po core):**
1. **Plugin Claude Code** — bundle config połączenia (URL + `Bearer ${VAR}`) + skill proaktywności.
2. **Dashboard:** przycisk ręcznego triggera nocnego jobu, przycisk hard-purge.

**v2 i dalej:**
1. **`kind=event` (episodic)** — zdarzenia z czasem. Auto-commit + age-decay w trust-tierze „unreviewed", memory-relations + 1-hop graph boost, timeline (`reverted-by`/`relates-to`).
2. **`conflicts_report`** — wykrywanie sprzeczności same-topic w nocnym jobie, ewentualnie z weryfikacją AI.
3. **Memory Worth** — prune po współwystępowaniu z sukcesem/porażką. Wymaga `report_outcome(memory_ids, success)` + tabeli `outcome`. Prune projektowany jako **pluggable** już w v1.
4. **Anti-fatigue kolejki** — bulk approve/reject, auto-allow po N spójnych decyzjach (`confidence`/`auto_eligible` w `proposals` — schema gotowa).
5. **Per-user auth** + kontrola dostępu per-projekt dla człowieka.
6. **Edycja pamięci przez agenta** (`supersedes: id`), agent-proposed edycje dokumentów, wiele tokenów per projekt + **graceful rotation**.
7. **OAuth 2.1 + PKCE** dla MCP (Desktop/web-connector).
8. **Interop wire-format** — mapowanie na granicy MCP (`remember↔create`…) gdy pojawi się drugie narzędzie.
9. Bulk-import dokumentów; chunk-targeted `get`; skalowanie poziome (rate-limiter na Redis).

---

## 11. Otwarte kwestie (do fazy implementacyjnej)

- **Wartości domyślne** (dostrajane na realnych danych): top-k, próg relevance, próg podobieństwa dedup, wiek/grace przed prune, stała `k` RRF, limity rate-limitera, budżet czasu embeddingu przy save, konkretne progi limitów wejścia.
- **Strategia chunkingu:** metoda podziału (po nagłówkach markdown?), target tokenów, overlap.
- **Mechanizm wykrywania „ten sam temat"** przy merge w nocnym jobie.
- **Dokładny zestaw wzorców skanera sekretów** (balans wykrywalność vs false-positive).
- **UX edycji dużych dokumentów** w dashboardzie; które dokumenty realnie migrować z repo (stabilne/przekrojowe grounding tak; docs sprzężone z ewolucją kodu zostają w git).
