# System pamięci dla agentów AI (MCP) — Plan projektu

**Faza 1: planowanie ogólne** · dokument roboczy

---

## 1. Cel i architektura (skrót)

Samodzielna aplikacja uruchamiana na serwerze lub w chmurze, która pełni rolę współdzielonej, trwałej pamięci dla Claude i innych agentów. Aplikacja:

- wystawia **remote MCP server**, do którego agenci się łączą, wyszukują kontekst do zadań i zapisują nowe fakty,
- rozróżnia projekt, z którego przychodzi wywołanie (przez credential, nie argument),
- każdy zapis treści przepuszcza przez **kolejkę akceptacji** — nic nie trafia do pamięci bez zatwierdzenia przez człowieka,
- udostępnia **dashboard** do przeglądu, edycji i zatwierdzania,
- co noc analizuje pamięć i **proponuje** dedup/merge/prune (propozycje, nie automatyczne zmiany).

Zasada przewodnia całego projektu: **prosto w v1, ale schema/architektura gotowa na rozszerzenia.**

---

## 2. Ustalenia — decyzje podjęte

### 2.1 Tenancy i scope
- `scope` = `global` | `project`. **Miękka izolacja** (metadana + filtr), bez twardej multi-tenancy.
- Projekt wyznaczany przez **credential** (token per projekt), nie przez argument agenta — agent nie ma jak wskazać cudzego projektu.
- `global` = wiedza współdzielona ponad projektami. Agent w search widzi: **swój projekt + global**.
- **Threat model (świadoma akceptacja):** miękka izolacja znaczy, że wyciek jednego tokenu = pełny odczyt **i zapis** danego projektu. Akceptowalne dla wewnętrznego narzędzia; mitygacja = rotacja tokenu w dashboardzie. Twarda multi-tenancy poza zakresem v1.
- **Audyt per-agent:** wspólny token projektu nie rozróżnia, *który* agent zapisał (audit-actor = token+projekt). Wiele tokenów per projekt (rozróżnianie agentów) — opcja na v2.

### 2.2 Użytkownicy
- Start: narzędzie dla jednej osoby; docelowo udostępnienie zespołowi, jeśli wyjdzie coś wartościowego.
- Zespół, ale **bez kont per-user w aplikacji** (v1). Dashboard z auth na poziomie aplikacji (współdzielony).
- Skala: kilka projektów, sporo dokumentów, kilku agentów jednocześnie miejscami.
- **Warunek żywotności v1 (założenie u podstaw).** Cała wartość („czysta, autorytatywna pamięć") stoi na tym, że **jeden recenzent nadąża zatwierdzać**. Dwa skutki do świadomej akceptacji: (a) **cross-agent latency** — fakt agenta A jest niewidoczny dla agenta B (ten sam projekt) do czasu akceptacji, więc współbieżne agenty nie dzielą świeżej wiedzy w czasie rzeczywistym (rozszerzenie trade-offu async-ack z 2.6 na współpracę agentów); (b) **wolumen** — jeśli zapisy rosną szybciej, niż jeden człowiek czyści kolejkę, potrzebny anti-fatigue (auto-allow, v2 — 5.4). v1 zakłada wolumen mieszczący się w przepustowości jednego recenzenta.

### 2.3 Model danych

**`memories`** (dokument kanoniczny):

| pole | opis |
|---|---|
| `id` | krótki, opaque, URL-safe (nanoid, np. `mem_a1b2c3`); stabilny — to go dostaje agent w search i podaje do get |
| `header` | krótki tytuł/streszczenie; **to zwraca search** |
| `body` | pełna treść (markdown) |
| `tags` | lista stringów |
| `scope` | `global` \| `project` |
| `project_id` | z credentialu przy zapisie; pusty dla `global` |
| `status` | `approved` \| `archived` (**soft-delete**, nigdy hard-delete) |
| `source` | `agent` \| `human` \| `nightly` (kto utworzył) |
| `created_at` / `updated_at` / `approved_at` | znaczniki czasu |
| `last_accessed_at` / `access_count` | feed dla prune w nocnym jobie — **zbierane od dnia zero**, nie do odtworzenia wstecz |

**`embeddings`** (relacja jeden-do-wielu — chunking):
- `memory_id`, `chunk_index`, `chunk_text`, `model` (`embedding_model`), `vector`.
- Mały dokument = jeden chunk (chunking wtedy praktycznie niewidoczny). Jedna ścieżka kodu dla małych i dużych.

**`proposals`** (kolejka akceptacji — **każda treściowa mutacja to proposal**):
- `type` = `create` | `update` | `merge` | `delete`
- `payload` (proponowana treść), `affected_ids` (których dokumentów dotyczy)
- `origin` = `agent` | `human` | `nightly`
- `status` = `pending` | `approved` | `rejected`

**`revisions`** — lekkie snapshoty przy każdej zatwierdzonej zmianie (żeby widzieć „co tu było wcześniej", zwłaszcza po przepisaniu przez nocny job).
- Strategia snapshotu: **pełny** dla `fact` (małe, tanie); dla dużych `document` rozważyć snapshot różnicowy (diff), żeby historia edycji nie puchła. → knob.

**`staging_embeddings`** — wektory policzone przy `save` (dla dedup), zanim proposal zostanie zatwierdzony. Ta sama struktura co `embeddings`, kluczowane `proposal_id`. Przy akceptacji przenoszone do `embeddings`; przy odrzuceniu/edycji — kasowane / liczone od nowa. Domyka cykl życia embeddingu z 2.7.

**`audit_log`** (append-only) — zdarzenia zmieniające stan (2.11):
- `id`, `event_type` (`proposal_created` / `approved` / `rejected` / `edited`, `human_edit`, `archive`, `promote`, `token_created` / `rotated`)
- `actor` (token + `project_id` dla maszyny albo `"human-dashboard"`), `affected_ids`, `revision_id` (opcjonalnie, before/after), `created_at`.
- Odczyty **nie** logowane per-event — zostają liczniki `access_count` / `last_accessed_at` (wolumen + prywatność).

### 2.4 Embeddingi i storage
- **Postgres + `pgvector` + wbudowany full-text (`tsvector`)** — jedna baza, transakcyjnie, bez dedykowanej bazy wektorowej. Index HNSW ciągnie setki tysięcy wektorów na tej skali.
- Provider embeddingów **konfigurowalny, ale zablokowany per deployment** (wariant A). Schema od dnia zero zapisuje `embedding_model` przy każdym wektorze → gotowość na wariant B (hot-swap z re-embedem) w przyszłości.
- Uwaga techniczna: różne modele = różny wymiar i nieporównywalna przestrzeń wektorów. Zmiana providera bez re-embedu = zepsute wyszukiwanie.
- Wybór konkretnego providera lokalnego (np. FastEmbed/bge) vs API — zależnie od tego, czy użytkownik priorytetyzuje prywatność (offline) czy jakość wyszukiwania.

### 2.5 Retrieval
- **Rozdzielone: co search *zwraca* (nagłówki) od tego, po czym *dopasowuje* (header + body).** Agent dostaje tanie w tokenach nagłówki do triage; dopasowanie idzie po pełnej treści, żeby wszystko było znajdywalne (nie zakładnik jakości nagłówków).
- **Hybrid retrieval**: wektor (`pgvector`, semantyka/synonimy) + FTS (`tsvector`, dokładne terminy techniczne: nazwy API, klucze configu, stringi błędów). Fuzja przez **Reciprocal Rank Fusion (RRF)** — bez tuningu wag (stała `k`, typowo 60).
- **Konfiguracja FTS = `simple`** (bez stemmingu). Powód: dokładne tokeny techniczne bez masakrowania mieszanki PL/EN — polski stemmer psułby angielskie terminy i odwrotnie. Fleksję polskich słów i semantykę bierze **wektor bge-m3** (multi-język); FTS zostaje przy dokładnym trafieniu tokenu. Świadomy podział ról wektor↔FTS.
- Poziomy: **wektor na chunkach, FTS na całym dokumencie**. W vector-searchu krok **collapse** — trafienia chunków grupowane po `memory_id`, najlepszy score na dokument, żeby ten sam dokument nie wyszedł kilka razy; potem RRF fuzuje listy *dokumentów*.
- Przepływ dwufazowy: `search_memory` → nagłówki; `get_memory(id)` → pełne body (v1 zwraca **całość**). Dla `kind=document` search dokłada do nagłówka **krótki excerpt dopasowanego chunku**, żeby agent często nie musiał ciągnąć całego PRD (pełny pull = świadomy wybór); dla `fact` sam nagłówek. Chunk-targeted `get` (zwrot samej sekcji) odłożony do v2, jeśli excerpt nie wystarczy.
- **Atomowość rekomendowana, nie wymuszona** — duże dokumenty dozwolone (stąd chunking).
- Tagi: podwójna rola — strukturalny filtr w search **oraz** dopisane do tekstu embedowanego.
- Top-k + próg relevance (odcięcie szumu) — wartości do dostrojenia.
- **Filtr po aktywnym modelu:** search zawsze zawęża wektory `WHERE embedding_model = <aktywny>` — podczas przebiegu re-embed modele współistnieją, a przestrzenie są nieporównywalne (2.4).
- **`kind` w search:** domyślnie zwraca `fact` + `document` razem (triage po nagłówku), z **opcjonalnym** filtrem `kind`. Zamyka otwarty punkt z sekcji 3.
- **Koszt embedowania query:** każdy `search` embeduje zapytanie tym samym providerem — przy `api` to koszt i egress treści query per wyszukiwanie (przy `local` bez znaczenia).
- **Eval retrievalu (v1-light):** mały labelowany zestaw `zapytanie → oczekiwane memory_id` + skrypt `recall@k` jako smoke-test regresji przy zmianach chunkingu / progów / modelu. Bez tego jakość search = wyczucie.

### 2.6 Interfejs MCP
- **Transport: Streamable HTTP**, jeden endpoint (POST+GET). Stary HTTP+SSE przestarzały od spec 2025-03-26; najnowsza rewizja transportu 2025-11-25. Nasze narzędzia są request/response → serwer może być **stateless na poziomie logiki app** (gotowość na skalowanie poziome). Uwaga: sidecar modelu (RAM) i rate-limiter w pamięci (2.11) trzymają stan → **serverless nie jest bliską ścieżką**, mimo bezstanowego app-tier.
- **Auth: statyczny bearer token per projekt** w nagłówku `Authorization`, serwer mapuje token → `project_id`. Jedno załatwia auth i rozpoznanie projektu. Dla wewnętrznego narzędzia zespołowego spec dopuszcza bearer/API key; pełny OAuth 2.1 + PKCE + PRM tylko gdyby serwer stał się publiczny (przyszłość, kod bearer się nie marnuje).
- **Narzędzia:**
  - `search_memory(query, tags?)` → `[{id, header, tags, score}]`. Scope wynika z tokena, nie jest argumentem.
  - `get_memory(id)` → pełne body; bumpuje `last_accessed_at` / `access_count`. **Egzekwuje scope** (`id` ∈ projekt tokena albo `global`, inaczej odmowa — IDOR, 2.11). Dla `document` mitygacja context-blowup przez excerpt w search (2.5).
  - `save_memory(header, body, tags)` → tworzy proposal, zwraca `{id, status: "pending"}`. **„Natychmiast" = bez czekania na człowieka**, ale odpowiedź niesie wynik dedup → `save` liczy embedding + dedup przed odpowiedzią (przy `api` = round-trip sieciowy). `id` mintowany przy proposalu; wiersz `memories` materializowany dopiero przy akceptacji.
- **Async ack — fire-and-forget.** Agent zapisujący fakt już go zna; gate akceptacji decyduje tylko o widoczności dla *przyszłych* sesji. Agent nie czeka, nie pollinguje.
  - Trade-off (świadomy): fakt zapisany w kroku 1 nie będzie znaleziony przez search w kroku 5 tej samej sesji (wciąż pending). Stan w obrębie sesji ma żyć w kontekście agenta, nie krążyć przez bramkowaną pamięć.
  - Dedup przy zapisie: sprawdza podobieństwo wobec `approved` **i** otwartych create-proposali; jeśli bliźniak czeka — może zwrócić `{status: "duplicate_pending", existing_id}` zamiast drugiej propozycji.
- **Zapisy agenta: tylko project-scoped.** Promocja do `global` = akcja człowieka w dashboardzie (lub propozycja nocnego joba).
- **Agent tylko tworzy (`create`) w v1.** Aktualizacja istniejących pamięci przez agenta — przyszła wersja (ewentualnie `supersedes: id` w `save`). Zmiany faktów na razie godzi dedup/człowiek w dashboardzie.

### 2.7 Write path / kolejka akceptacji
- **Kolejka = tabela `proposals`, nie flaga `status=pending` na dokumencie.** Powód: merge (A+B→C) to nie „nowy pending dokument", tylko operacja „utwórz C, zarchiwizuj A, zarchiwizuj B" — flaga tego nie wyrazi. Jeden mechanizm i jedna powierzchnia audytu dla zapisów agenta, edycji człowieka i propozycji nocnego joba.
- Zatwierdzenie **aplikuje zmianę transakcyjnie** na `memories`; odrzucone zostają do audytu.
- **Pending żyje tylko w `proposals`** → `search` (uderzający w `memories`) z definicji widzi tylko `approved`. Czysta, autorytatywna pamięć; duplikaty w kolejce łagodzi dedup przy zapisie.
- Zapisy techniczne (`access_count`, `last_accessed_at`) idą **bezpośrednio**, z pominięciem kolejki — gate jest dla treści, nie dla liczników.
- **Cykl życia embeddingu (save→approval).** Wektor liczony przy `save` (dla dedup) ląduje w `staging_embeddings` (2.3), powiązany z proposalem; **akceptacja przenosi** go do `embeddings` + materializuje wiersz `memories`; **edit-before-approve unieważnia staged wektor → re-embed** przy akceptacji; odrzucenie kasuje staging. Bez podwójnego liczenia w happy-path.

### 2.8 Nocny job
- **Proposer, nie executor.** Wyniki dedup/merge/prune trafiają do `proposals` jako propozycje z diffem, zatwierdzane tak samo jak zwykły zapis. Cichy merge/delete byłby najgorszym failure mode systemu pamięci.
- **Skanowanie ≠ merge.** Job ogląda *wszystko* (dużych dokumentów nie wyłącza z przeglądu), ale **scala wąsko**: tylko przy prawdziwym pokryciu tego samego pojedynczego tematu. Jeśli w dokumencie jest wiele tematów, a tylko jeden pokrywa się z czymś innym — nie scala całości (papka).
- Gate akceptacji jest backstopem dla złego merge'a; heurystyka „ten sam temat" chroni głównie **sygnał/szum w kolejce**, nie bezpieczeństwo.
- Dedup (podobieństwo powyżej progu) — deterministyczny i tani. Merge/rewrite przez LLM i tak wymaga przeglądu.
- Prune/staleness korzysta z `last_accessed_at` / `access_count`.
- **Prune cold-start:** nowy `fact` ma z natury niski `access_count` → minimalny **wiek/grace** przed kwalifikacją do prune, żeby świeże fakty nie były przycinane przedwcześnie.
- **Dedup przez ANN, nie O(n²):** kandydaci na duplikaty szukani przez indeks wektorowy (near-neighbors per pamięć), nie pełnym porównaniem par — inaczej nocny przebieg nie skaluje się z liczbą faktów.

### 2.9 Infra / stack / deployment
- **Hosting: pojedynczy VPS + Docker Compose**, nie serverless. Serwer MCP zostaje stateless (skalowanie później możliwe), ale w v1 jeden host = najprościej i przewidywalnie; serverless dokłada connection pooling do Postgresa, cold start i uniemożliwia lokalne embeddingi. VPS daje **stabilny publiczny endpoint HTTPS**, którego wymaga remote MCP (agenci łączą się po sieci).
- **Serwisy compose:** `proxy` (**Caddy** — terminacja HTTPS + auto Let's Encrypt; routuje `/mcp` publicznie, dashboard/API tylko z VPN/CF Access — domyka ekspozycję z 2.10), `db` (obraz `postgres`+`pgvector`), `app` (serwer MCP + dashboard w jednym procesie), `nightly` (cron/scheduled job dla dedup/merge/prune), `embeddings` (opcjonalny sidecar modelu lokalnego).
- **Embeddingi — obie ścieżki wspierane, wybór per deployment, `local` domyślny.** Model lokalny potraktowany jako **kolejny provider embeddingów po HTTP** → jeden interfejs providera, dwie implementacje (`local` → kontener sidecar w sieci compose, `api` → OpenAI/Voyage/…). `EMBEDDING_PROVIDER` w env przełącza; **jedna ścieżka kodu** w retrievalu. Doprecyzowanie wariantu A z 2.4: „wybór użytkownika" = przy konfiguracji, **nie per-request** (różne modele = różny wymiar i nieporównywalna przestrzeń; zmiana modelu = `ALTER` kolumny `vector` o stałym wymiarze + re-embed wszystkiego + rebuild HNSW — „wspierane" znaczy „kod obu ścieżek gotowy", **nie** tani runtime-swap).
  - Sidecar lokalny: **TEI (HuggingFace Text Embeddings Inference)** — dedykowany, wydajny, endpoint HTTP, oficjalny obraz Dockera (CPU/GPU). Alternatywa: Ollama. Wpięty w **compose profile** (`local-embeddings`) → startuje tylko przy `EMBEDDING_PROVIDER=local`; przy `api` kontener się nie podnosi.
  - Domyślny model lokalny: **bge-m3** (multi-język, 1024 dim) — treść pamięci jest mieszana PL/EN, a modele EN-only (MiniLM, bge-small) gubią dopasowania po polsku. Koszt: ~2–4 GB RAM. GPU niepotrzebne przy tej skali (embedowanie tylko przy zapisach i zapytaniach).
- **Sizing VPS wg embeddingów:** `api` → ~2 GB; `local` lekki (bge-small/nomic) → ~4 GB; **`local` multi-język (bge-m3/e5-large) → ~8 GB** (Postgres + app + model + zapas na budowę indeksu HNSW). Przy local-first z bge-m3 celujemy w **8 GB**.
- **Config: 12-factor env** (DB URL, provider + model + wymiar + klucz API). **Projekty i tokeny w tabeli `projects`** (token jako hash), nie w env — dodanie projektu bez redeployu; domyka mapowanie bearer→`project_id` z 2.6.
- **Bootstrapping / first-run:** komenda seed/CLI (`create-project`, `rotate-token`) do założenia pierwszego projektu i tokenu; hasło dashboardu z env przy pierwszym starcie, zmiana potem w dashboardzie (2.10).
- **Sekrety:** klucze API i seed hasła jako `.env` / Docker secrets na hoście — nie w obrazie, nie w repo.
- **Backup:** `pg_dump` na cronie (jedna baza = jedno źródło prawdy, wektory są w dumpie) + kopia offsite, retencja N dni.
- **Migracje:** narzędzie migracyjne od dnia zero (schema z sekcji 2 to kilka powiązanych tabel + rozszerzalny enum `kind`).

### 2.10 Dashboard
- **Stack: SPA (React) + JSON API.** `app` serwuje trzy powierzchnie na jednym origin: (1) endpoint MCP (Streamable HTTP, bearer), (2) JSON API dashboardu (sesja), (3) statyczny bundle SPA. Build SPA = krok w obrazie compose, assety serwowane przez `app`.
  - Implikacja dla języka backendu (dotąd odłożonego): SPA+JSON API **nie wymusza** języka, ale TS po obu stronach daje współdzielone typy API. Rozstrzygnięcie w fazie impl.
- **Auth: dwie rozłączne powierzchnie.**
  - MCP: **publiczny + bearer per projekt** (maszyna) — z 2.6.
  - Dashboard + JSON API: **wspólne hasło aplikacji → podpisany cookie sesji, tylko HTTPS**, dodatkowo **za VPN/proxy (Tailscale / Cloudflare Access)** — dashboard niewystawiony publicznie, druga warstwa poza samym hasłem. Wymienne na per-user auth później (v2), bez zmiany reszty.
  - Reverse proxy rozdziela ekspozycję: ścieżka MCP publiczna, ścieżki dashboard/API tylko z VPN/CF Access. Cookie sesji `SameSite` + ochrona CSRF na mutacjach (API w przeglądarce).
- **Ekrany (4):**
  1. **Kolejka akceptacji** — `pending` proposale, filtr po `origin` (agent/human/nightly) i `type`. Diff zależny od typu: `create` = sam dokument (brak „przed"); `update` = diff pól (header/body/tags); `merge` = A+B→C obok siebie; `delete`/archive = co znika. **Edit-before-approve** (header/body): commit odzwierciedla edycję, oryginalny payload agenta zostaje w proposalu („approved with edits") + `revision`. Propozycje nocnego joba = **ten sam ekran**, filtr `origin=nightly` (nie osobny widok — spójne z „jedną kolejką" z 2.7).
  2. **Przeglądarka pamięci** — `approved`/`archived`, filtry: projekt, `scope`, `kind`, tagi, status. Detal: header, body, tagi, metadane, `access_count`/`last_accessed_at`, historia `revisions`. Akcje człowieka = **commit bezpośredni + `revision`** (2.7): edycja, archiwizacja, promocja do `global`, zmiana `scope`/`kind`.
  3. **Projekty / tokeny** — CRUD projektów, generowanie/rotacja bearer tokena (widoczny raz przy tworzeniu, w bazie hash).
  4. **Audyt** — odrzucone proposale + przegląd `revisions` (część detalu pamięci + jeden widok „rejected").
- **Odłożone (v2):** bulk approve/reject i „auto-allow po N spójnych decyzjach" (anti-fatigue z 5.4); live-update kolejki (v1: polling).

### 2.11 Non-functional
- **Kontrola dostępu na odczyt.** Read w MCP filtrowany tokenem (projekt + `global`) — z 2.1. Twardy punkt: **`get_memory(id)` egzekwuje scope** — `id` musi należeć do projektu z tokena albo być `global`, inaczej agent poda cudze `id` i przeczyta obcy projekt (**IDOR**). Bez tego miękka izolacja z 2.1 przecieka na ścieżce `get`. Dashboard read = bez ograniczeń (zaufany człowiek, wspólny auth); restrykcje per-projekt dopiero z per-user auth (v2).
- **Audit log.** Append-only, zdarzenia zmieniające stan: proposal `created`/`approved`/`rejected`/`edited`, human edit, archive, promote, token created/rotated — z **aktorem** (który token+projekt albo „human-dashboard"), czasem i referencją do `revision` (before/after). Odczyty **nie** per-event (wolumen + prywatność) — zostają liczniki `access_count`/`last_accessed_at`. Domyka wektor zatrucia z 5.4#2: każdy zapis, który wszedł do pamięci, ma ślad, kto go wepchnął.
- **Rate limiting.** Per-token (token bucket) na endpoint MCP — publiczny, więc realne ryzyko runaway-agenta / zalania kolejki. Ostrzej na `save_memory` (koszt embeddingu + tworzy proposal), luźniej na `search`/`get`. Chroni też przed skompromitowanym tokenem floodującym kolejkę. Wartości do dostrojenia. Dashboard za VPN → mniej krytyczny. Uwaga: licznik w pamięci działa dla jednej instancji; przy skalowaniu poziomym app (2.6) trzeba przenieść do współdzielonego store (np. Redis) — poza v1.
- **Observability.** Proporcjonalnie do jednego VPS: **structured logs na stdout** (Docker zbiera), `/health` dla proxy, minimalne metryki (pending count / głębokość kolejki, latencja embeddingu, wynik ostatniego nocnego jobu) **wystawione w dashboardzie** — nie pełny Prometheus/Grafana. Stack metryczny łatwo dołożyć później; nie płacimy za niego w v1.
- **Retencja `archived`.** Soft-delete nigdy nie kasuje wiersza (2.3) → `archived` żyją bezterminowo (audyt, `revisions` się do nich odwołują). Ale **embeddingi kasowane przy archiwizacji** (wiersz pamięci zostaje, wektory znikają z indeksu) — `archived` i tak nie ma być wyszukiwalne, więc trzymanie go w HNSW tylko puchnie indeks. Twardy purge dopiero gdyby wolumen bolał; dla `kind=event` (v2) osobny mechanizm `expire`/TTL z sekcji 4.

---

## 3. Do doprecyzowania (w obrębie omówionych tematów)

- **Mechanizm wykrywania „ten sam temat"** przy merge w nocnym jobie: proxy po rozmiarze (jedno- vs wielo-chunkowe) vs jawna flaga `mergeable` przy zapisie vs detekcja tematyczna. → odłożone do dalszej fazy.
- ~~**`get_memory` dla dużych dokumentów**~~ → **rozstrzygnięte:** v1 = całość, ale search dokłada excerpt dopasowanego chunku dla `document` (2.5/2.6); pełny chunk-targeted `get` odłożony do v2, jeśli excerpt nie wystarczy.
- **Strategia chunkingu**: metoda podziału (po nagłówkach markdown?), target tokenów, overlap. → **faza implementacyjna** (knob, dostrajany razem z retrievalem).
- **Provider(zy) embeddingów**: który lokalny (FastEmbed/bge?) i które API wspierać na start.
- **Wartości domyślne**: top-k, próg relevance, próg podobieństwa dedup, wiek/grace przed prune, stała `k` RRF, limity rate-limitera. → **faza implementacyjna** (dostrojenie na realnych danych, nie da się ustalić z planu).
- **Widoczność pending w search**: decyzja = nie (tylko approved), ale zanotowane jako punkt do ewentualnego powrotu, gdyby duplikaty w kolejce okazały się problemem.
- **Podział `kind`: klasa pamięci (lifecycle)** — decyzja: **wchodzi do v1** jako `fact` | `document`; trzecia wartość `event` planowana na v2 (patrz sekcja 4). Dyskryminator `kind` na tabeli `memories` (nie osobna tabela — reużycie `embeddings` / `proposals` / `revisions`, jedna ścieżka retrievalu i chunkingu). `kind` opisuje **czym pamięć JEST**, nie kto ją zapisał — autorstwo zostaje w polu `source`, więc enum jest płaski i nie ma pustych kombinacji (nie potrzeba ortogonalnego wymiaru `type`).
  - `fact` = fakty accreted przez agenta (mutowalne, podlegają dedup / supersession / prune).
  - `document` = dokumenty authored przez człowieka (PRD, MVP, roadmap) przedstawiające projekt, trzymane tutaj zamiast w repo (kanon, permanentne).
  - Nocny job działa **tylko** na `kind=fact` — nigdy nie proponuje merge/prune dla `document` (rekord kanoniczny, nie churny fakt).
  - Bramka akceptacji wg **origin, nie kind**: `source=agent` → kolejka `proposals` (agent może *proponować* edycję dokumentu, np. „zaznacz feature jako done w roadmap"); `source=human` → commit bezpośredni + `revision`, z pominięciem kolejki. Zero nowej logiki kolejki — wynika z istniejącego pola `source`.
  - `document` to główny przypadek „dużych dokumentów" → domyka się z punktem o `get_memory` / chunk-targeted retrieval powyżej (zwrot dopasowanej sekcji zamiast całego PRD).
  - Model 2D: `scope` × `kind`. `document` może być `scope=global` (współdzielony glossary / standard / konwencje) lub `scope=project` (PRD tego projektu).
  - Do doprecyzowania w obrębie tej decyzji: UX edycji dokumentów w dashboardzie; które dokumenty realnie migrować z repo (per-dokument — stabilne/przekrojowe grounding tak; docs sprzężone z ewolucją kodu raczej zostają w git, żeby uniknąć dual source of truth); `search_memory` a `kind` (**rozstrzygnięte** — zwraca `fact`+`document` razem, opcjonalny filtr `kind`, 2.5).

---

## 4. Tematy jeszcze niezaplanowane (dalszy ciąg agendy)

- ~~**Dashboard**~~ — **zaplanowane, patrz 2.10** (SPA React + JSON API, 4 ekrany, auth: hasło app + sesja za VPN/proxy, MCP-bearer osobno).
- ~~**Infra / stack / deployment**~~ — **zaplanowane, patrz 2.9** (VPS + Docker Compose, embeddingi `local`/`api` przełączane env-em, tokeny w tabeli `projects`, backup `pg_dump`).
- ~~**Non-functional**~~ — **zaplanowane, patrz 2.11** (IDOR guard na `get_memory`, audit log zapisów, rate limiting per-token, structured logs + `/health`, `archived` bezterminowo ale bez embeddingów).
- **`kind=event` (episodic) — planowane na v2.** Trzecia wartość `kind` dla zdarzeń z czasem: naprawy błędów, incydenty, decyzje z datą. Motywacja: gdy nowy bug się pojawi, znaleźć powiązanie ze starą naprawą tego samego komponentu. Implikacje projektowe:
  - **Retencja = age-decay w rankingu, nie prune-delete.** Świeży event wysoko, stary opada, ale **przeżywa** — to dana korelacyjna na przyszłe debugowanie. Naturalny dom dla operacji `expire`/TTL (opcjonalne archiwum po długim oknie, jeśli wolumen zaboli) — odwrotnie niż `fact` (prune'owany) i `document` (permanentny).
  - **Memory-relations + 1-hop graph boost** (dziś odłożone) tu zarabia na siebie: sama similarity wektorowa łapie korelację po objawach, ale przegapi powiązanie „nowy bug ↔ stara naprawa tego samego pliku/komponentu" przy różnych objawach. Link `fix → komponent` + boost przy recall to łapie. To sedno „znaleźć powiązanie".
  - **Timeline, nie płaskie fakty.** Eventy się nie sprzeczają (dwie naprawy z różnych dat obie się wydarzyły), ale naprawa może być cofnięta/zastąpiona → łańcuch relacji (`reverted-by` / `relates-to`); sama wiedza „ta naprawa została potem cofnięta" to cenny sygnał.
  - **Decyzja (rozstrzygnięta): auto-commit + age-decay w osobnym trust-tier.** Eventy generują się często → pełna bramka = zmęczenie kolejki; czyta się je jako „oto co się wydarzyło, oceń trafność", nie asercję faktu. Więc: **auto-commit**, recallowalne, **age-decay** w rankingu, ale oznaczone **„unreviewed"** — nigdy nie auto-promują do `global` ani nie wpływają na ranking `fact` poza wyświetleniem / graph-boostem. Przegląd szumu **batch = pull** (dashboard), bez per-event kolejki. **Escape hatch:** zaostrzyć do bramkowanych, jeśli pojawi się zatrucie eventami — odwracalne. Ogranicza blast radius zatrucia bez łamania tożsamości human-approved.
  - Warunek dla v1: schema zostawia miejsce — `kind` jako rozszerzalny enum, `revisions` i (przyszła) tabela relacji zaprojektowane tak, żeby `event` + linki doszły bez bolesnej migracji.

---

## 5. Prior-art — znaleziska z researchu (do analizy w następnej sesji)

**Decyzja o kierunku:** projekt prowadzony jako **narzędzie osobiste/zespołowe + nauka**, nie jako produkt do wyróżnienia się na rynku.

### 5.1 Wniosek główny
Rdzeniowa cecha projektu — **zapis pamięci zatwierdzany przez człowieka** — to sformalizowany, nazwany wzorzec: *Co-memorize diff-and-approve* w nurcie *Governed Memory*. Definicja pokrywa się jeden do jednego z naszą tabelą `proposals`: agent proponuje zapis → system liczy strukturalny diff względem stanu bieżącego → recenzent-człowiek zatwierdza/odrzuca → commit tylko po zatwierdzeniu; wzorzec generalizuje się na remember/forget/merge. To **aktywny obszar badawczy 2026**, nie pojedyncza aplikacja. Wniosek: pomysł jest zwalidowany (realny popyt), ale nie jest nowatorski.

### 5.2 Najbliżej naszego planu

| Projekt | Co ma | Różnica względem nas |
|---|---|---|
| **memorywire** (arxiv 2606.01138) | Wire-format + governance channel = Co-memorize diff-and-approve. Zapisy `approval_required` odkładane za sentinelem, niewidoczne dla recall do decyzji recenzenta. Audit log jako jedyne źródło prawdy. Referencyjne UI. Pętla uczenia akceptacji (auto-allow po N spójnych decyzjach). Eksperyment adwersarialny na fuzji RRF/MAX/weighted. | Standard wire-format + referencyjne UI, nie gotowy deployable produkt zespołowy. **Feature-po-featurze pokrywa nasz write path.** |
| **ipiton/agent-memory-mcp** (GitHub) | `review_queue`, `merge_duplicates`, `mark_outdated`, `promote_to_canonical`, `conflicts_report`. Sedymentacja: trywialne promocje auto, reszta do kolejki do przeglądu. Hybrid retrieval. Świadomość modelu embeddingowego + flow `reembed` przy zmianie modelu. | Jawnie **solo-local**, SQLite, transport głównie stdio. Nasz cel to remote/zespołowy. **Najbliższa istniejąca implementacja OSS.** |
| **doobidoo/mcp-memory-service** (~1.6k★) | REST + MCP + OAuth + CLI + **dashboard**, knowledge graph, konsolidacja. | Konsolidacja **autonomiczna**, nie zatwierdzana przez człowieka. |
| **Oracle AI Agent Memory** | Governed unified memory core, izolacja multi-tenant na warstwie store, wektor + relacyjny + graf w jednym silniku. | Komercyjny, enterprise. |
| **adamrdrew/agent-memory-mcp**, **Mem0 / OpenMemory** | Hybrid BM25 + wektor przez RRF, lokalne embeddingi all-MiniLM-L6-v2 (adamrdrew). Qdrant + Postgres, `add/search/list/delete` (Mem0). | Warstwa retrievalu = dziś **stawka wejścia**; brak bramki akceptacji. |

Dalsze tło do przejrzenia: Governed Collaborative Memory (arxiv 2605.04264), Governed Shared Memory for Multi-Agent (arxiv 2606.24535), When to Forget / Memory Worth (arxiv 2604.12007), NousResearch/hermes-agent issue #44963 (staging zapisów pamięci odróżniony od zwykłych zgód narzędziowych — dokładnie nasza intuicja, że zapis pamięci jest wrażliwszy niż zwykła zgoda).

### 5.3 Nasza nisza
Żaden pojedynczy projekt OSS nie trafia w **pełną kombinację**: remote MCP (Streamable HTTP) + scoping projektu przez credential + kolejka akceptacji + nocny proposer + dopracowany dashboard + dwufazowy retrieval header/body, self-hosted, zespołowo, provider konfigurowalny. ipiton jest solo-local; doobidoo ma dashboard, ale konsolidację autonomiczną; memorywire to wire-format, nie produkt. Ta przestrzeń realnie jest pusta — co uzasadnia projekt jako narzędzie, nawet jeśli wzorzec nie jest nowy.

### 5.4 Do przejęcia z researchu (zanim powstanie kod)
1. **Prune** — zamiast/obok `access_count` rozważyć **Memory Worth**: dwa liczniki współwystępowania pamięci z sukcesem vs porażką, wspierające supresję / re-weryfikację / deprecację. Ściśle lepszy sygnał niż samo „było czytane". (arxiv 2604.12007) → **Decyzja: v2.** Wymaga kanału outcome, którego dziś nie ma — narzędzie `report_outcome(memory_ids, success)` + tabela `outcome` (analogicznie do `embeddings`/`revisions`). v1 prune liczy na `access_count`/recency (2.3), ale sygnał „worth" **projektujemy jako pluggable** — nocny job czyta abstrakcyjny score, v2 podmienia recency→success/failure co-occurrence bez migracji. Forward-compat: zostawić miejsce na tabelę `outcome`.
2. **Bezpieczeństwo retrievalu** — uwzględnić atak wstrzyknięcia na rank-0 w fuzji hybrydowej (przebadany na RRF/MAX/weighted w memorywire). Złośliwa lub błędna pamięć może wejść na szczyt wyników — nie uwzględniliśmy tego w retrievalu.
3. **Wire-format** — rozważyć zgranie z governance JSON schema memorywire dla interoperacyjności (inne narzędzia → nasz backend „za darmo"). Opcjonalne, strategiczne. → **Decyzja: bez renamu nazw wewnętrznych.** `create/update/merge/delete` zostaje źródłem prawdy; sprzęganie z alpha-specem dla spekulacyjnego interop się nie opłaca. Interop dokładamy **mapowaniem na granicy MCP** (`remember↔create`, `forget↔delete`, `merge↔merge`) dopiero, gdy pojawi się konkretne drugie narzędzie. Tania opcjonalność, zero kosztu teraz.
4. **Anti-fatigue kolejki** — „auto-allow po N spójnych decyzjach recenzenta" jako v2 kolejki; adresuje problem zaśmiecania kolejki, który sami zidentyfikowaliśmy (sekcja 2.8).

---

*Faza 1 domknięta: ustalenia zamknięte dla tenancy, modelu danych, retrievalu, MCP, write path, nocnego joba, infry (2.9), dashboardu (2.10) i non-functional (2.11). Kierunek: narzędzie osobiste/zespołowe + nauka.*

*Analiza prior-art: **zrobiona** — patrz `research-prior-art-pamiec-agentow.md`. Wszystkie znaleziska z sekcji 5 zweryfikowane jako realne (numer issue #44963 też — repo Hermes ma 213k★). Decyzja: **własne z inspiracją** (żaden OSS nie trafia w pełną kombinację; najbliższy ipiton jest solo-local; memorywire to alpha wire-format, nie produkt). memorywire → kopalnia designu + opcjonalne zrównanie słownika operacji, bez zależności od kodu.*

*Otwarte decyzje rozstrzygnięte kierunkowo: event → auto-commit + age-decay w trust-tierze „unreviewed" (sekcja 4); słownik memorywire → bez renamu, adapter na granicy MCP gdy zajdzie potrzeba (5.4#3); Memory Worth → v2, prune projektowany jako pluggable + tabela `outcome` (5.4#1).*

*Przegląd krytyczny Fazy 1: **wykonany** — uzupełnienia i korekty wpięte in-place w 2.1–2.11 i sekcję 3. Najważniejsze: nowe tabele `staging_embeddings` i `audit_log` (2.3), serwis `proxy`/Caddy + bootstrapping + koszt re-embedu (2.9), FTS=`simple` + filtr `embedding_model` + `kind` w search + eval-harness (2.5), cykl życia embeddingu save→approval (2.7), threat model miękkiej izolacji (2.1), warunek przepustowości akceptacji + cross-agent latency (2.2), korekty założeń „stateless/serverless" i „save natychmiast" (2.6).*

*Następny krok: faza implementacyjna — schema SQL (tabele z sekcji 2 + rozszerzalny enum `kind`, miejsce na `outcome`/relacje), szkielet serwera MCP (Streamable HTTP + 3 narzędzia), Docker Compose (`proxy`/`db`/`app`/`nightly`/`embeddings`).*
