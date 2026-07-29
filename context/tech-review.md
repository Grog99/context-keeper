# Context Keeper — Przegląd techniczny

Co narosło w architekturze i co z tym robimy. Zakres i plan → [`roadmap.md`](roadmap.md), kanon
architektury → [`tech-stack.md`](tech-stack.md), rzeczy odłożone produktowo → [`backlog.md`](backlog.md).

**Aktualizacja:** 2026-07-29 · **Okno:** pierwszy przegląd — objęta cała historia repo (85 commitów,
od Fazy 1 do v1.3 w toku)

Legenda: 🔴 boli teraz · 🟠 będzie boleć · 🟢 higiena · ✅ zrobione

> Ustalenia powstały z fan-outu trzech recenzentów read-only (dryf dokumentacji + struktura /
> zależności + testy / dane + operacje), a każdy cytowany `plik:linia` został zweryfikowany w źródle
> przed wpisaniem tutaj. Zero ustaleń odpadło na weryfikacji. Przyjęte pozycje mają lustro w
> [`backlog.md`](backlog.md) → „Dług techniczny / architektura".

---

## Otwarte

| #   | Ustalenie                                        | Wymiar    | Waga | Koszt |
| --- | ------------------------------------------------ | --------- | ---- | ----- |
| 1   | Sesja dashboardu w logach produkcyjnych          | ops       | 🔴   | S     |
| 2   | „1 dni temu" w UI                                | front     | 🔴   | S     |
| 3   | JSON API dashboardu bez walidacji runtime        | ops       | 🔴   | M     |
| 4   | `/health` bez limitu na publicznym porcie MCP    | ops       | 🔴   | S     |
| 5   | `GET /api/proposals` bez `LIMIT`                 | dane      | 🟠   | M     |
| 6   | ⌘K: request na każdy klawisz + brak indeksu      | dane      | 🟠   | M     |
| 7   | Filtr projektu w Audycie: brak GIN i brak limitu | dane      | 🟠   | M     |
| 8   | Dwie implementacje archiwizacji, już rozjechane  | struktura | 🟠   | M     |
| 9   | Zapis embeddingów przepisany w 7 miejscach       | struktura | 🟠   | M     |
| 10  | Typy SPA jako ręczne lustro enumów serwera       | struktura | 🟠   | S     |
| 11  | `apps/dashboard` bez runnera testów              | testy     | 🟠   | M     |
| 12  | Throttle logowania bez testu                     | testy     | 🟠   | S     |
| 13  | Granica portów MCP/dashboard bez testu           | testy     | 🟠   | S     |
| 14  | `pnpm audit` nie może być bramką                 | deps      | 🟢   | S     |
| 15  | Odwrócona zależność ESLint w dashboardzie        | deps      | 🟢   | S     |

> **Zaplanowane (reconcile 2026-07-29):** pozycje 1–4 (wszystkie 🔴) weszły do zakresu **v1.4** —
> [`roadmap.md`](roadmap.md), sekcja „Dług techniczny 🔴". Pozostałe (5–15) zostają w
> [`backlog.md`](backlog.md).

### 1. Sesja dashboardu w logach produkcyjnych 🔴

| Pole         | Treść                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | `redact` obejmuje wyłącznie stronę żądania, a domyślny `resSerializer` pino wkłada do logu wszystkie nagłówki odpowiedzi.                                                                           |
| **Dowód**    | `apps/server/src/app.module.ts:19`                                                                                                                                                                  |
| **Powoduje** | `Set-Cookie: ck_session` z `POST /api/auth/login` trafia do stdout kontenera — kto ma dostęp do logów, ma ważną sesję (hard-purge, bulk-approve, tokeny) plus `ck_csrf`, więc i obrona CSRF odpada. |
| **Fix**      | Dopisać `res.headers["set-cookie"]` do `redact` albo dać własny serializer `res` zwracający sam `statusCode`.                                                                                       |
| **Koszt**    | S                                                                                                                                                                                                   |

### 2. „1 dni temu" w UI 🔴

| Pole         | Treść                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Objaw**    | `${diffD} dni temu` bez odmiany przez liczebnik i bez górnego progu; sąsiedni `pluralProposals` w tym samym pliku odmienia poprawnie.      |
| **Dowód**    | `apps/dashboard/src/lib/format.ts:11`                                                                                                      |
| **Powoduje** | Dla 24–35 h UI renderuje „1 dni temu", a pamięć sprzed dwóch lat — „730 dni temu"; widoczne w kolejce, przeglądarce pamięci i osi rewizji. |
| **Fix**      | `Intl.RelativeTimeFormat('pl', { numeric: 'auto' })` — platformowe, zero zależności, gratis „wczoraj".                                     |
| **Koszt**    | S                                                                                                                                          |

### 3. JSON API dashboardu bez walidacji runtime 🔴

| Pole         | Treść                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | `@Query()` w kontrolerach to czysta asercja typu TS; powierzchnia MCP jest walidowana zodem, bliźniacza `/api` nie jest wcale.                                  |
| **Dowód**    | `apps/server/src/dashboard/memories.controller.ts:46`, `apps/server/src/dashboard/audit.controller.ts:30`, diagnoza w komentarzu `memories.controller.ts:86`    |
| **Powoduje** | `?kind=bogus` dolatuje do enuma Postgresa (500 zamiast 400), `?limit=abc` daje `LIMIT NaN`, `?from=wczoraj` — `Invalid Date`; SPA dostaje `code === undefined`. |
| **Fix**      | `ZodValidationPipe` rzucający `ToolError('validation_error')`, który `DashboardErrorFilter` już mapuje na 400 — zod jest zależnością.                           |
| **Koszt**    | M                                                                                                                                                               |

### 4. `/health` bez limitu na publicznym porcie MCP 🔴

| Pole         | Treść                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | Kontroler bez guarda, `surface.middleware` jawnie wpuszcza `/health` na `PORT_MCP`; każde wywołanie robi `SELECT 1` i fetch do TEI bez cache. |
| **Dowód**    | `apps/server/src/health/health.controller.ts:12`, `apps/server/src/dashboard/surface.middleware.ts:19`                                        |
| **Powoduje** | Nieuwierzytelniony flood wyczerpuje pulę `pg` i zapycha sidecar TEI, przez co `search_memory` realnych agentów degraduje się do FTS-only.     |
| **Fix**      | Cache wyniku `embeddingProvider.health()` ~5 s, albo objąć kontroler `McpIpThrottleGuard` z własnym, wyższym limitem.                         |
| **Koszt**    | S                                                                                                                                             |

### 5. `GET /api/proposals` bez `LIMIT` 🟠

| Pole         | Treść                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | `listPending` nie ma limitu ani kursora, a `select()` ciągnie `payload`/`edited_payload` (jsonb do 256 KB).                                       |
| **Dowód**    | `apps/server/src/proposals/proposals.service.ts:190`, konsument `apps/dashboard/src/screens/QueueScreen.tsx:162`                                  |
| **Powoduje** | Kolejka odpytywana co 15 s z otwartej karty, nocny job dokłada do 200 propozycji na przebieg; `?status=approved` zwraca całą historię instalacji. |
| **Fix**      | Limit + keyset po `created_at` (wzorzec jest w `AuditService.query`) i projekcja bez payloadów dla listy.                                         |
| **Koszt**    | M                                                                                                                                                 |

### 6. ⌘K: request na każdy klawisz + brak indeksu 🟠

| Pole         | Treść                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | Paleta woła API bez debounce'u i `AbortController`, a zapytanie robi `ILIKE '%q%'` i sortuje po nieindeksowanym `updated_at`.                     |
| **Dowód**    | `apps/dashboard/src/components/CommandPalette.tsx:41`, `apps/server/src/memory/memory-admin.service.ts:213`, indeksy w `db/schema/memories.ts:40` |
| **Powoduje** | 12-znakowe zapytanie = 11 pełnych skanów tabeli (wszystkie projekty, bez filtra statusu), z których klient zachowuje 8 wierszy z 200.             |
| **Fix**      | Debounce ~250 ms + `AbortController`, indeks `memories(updated_at DESC)`, `limit` przekazywany z kontrolera.                                      |
| **Koszt**    | M                                                                                                                                                 |

### 7. Filtr projektu w Audycie: brak GIN i brak limitu 🟠

| Pole         | Treść                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | `query` ściąga wszystkie id pamięci projektu bez `LIMIT`, po czym wstawia je jako parametr do `arrayOverlaps` na kolumnie bez indeksu.      |
| **Dowód**    | `apps/server/src/audit/audit.service.ts:65`, indeksy w `apps/server/src/db/schema/audit-log.ts:20`                                          |
| **Powoduje** | Koszt rośnie iloczynem rozmiaru pamięci projektu i rozmiaru audytu, i powtarza się przy każdej stronie „Załaduj więcej"; ścieżka jest w UI. |
| **Fix**      | GIN na `affected_ids` + podzapytanie `EXISTS` zamiast round-tripu przez Node; docelowo denormalizowany `project_id` na `audit_log`.         |
| **Koszt**    | M                                                                                                                                           |

### 8. Dwie implementacje archiwizacji, już rozjechane 🟠

| Pole         | Treść                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | Ta sama operacja (status, `version`, kasowanie embeddingów i krawędzi, audyt, rewizja) żyje w dwóch serwisach; komentarz przyznaje „Mirror".       |
| **Dowód**    | `apps/server/src/proposals/proposals.service.ts:879`, `apps/server/src/memory/memory-admin.service.ts:547`                                         |
| **Powoduje** | Rozjazd już nastąpił — dwie różne wartości `via` dla tego samego zdarzenia i snapshot rewizji bez `eventTime`; forensyka audytu wymaga obu wersji. |
| **Fix**      | Wspólne `archiveMemoryTx(tx, row, actor, via)` w module `memory/` plus jedna definicja `snapshotOf`.                                               |
| **Koszt**    | M                                                                                                                                                  |

### 9. Zapis embeddingów przepisany w 7 miejscach 🟠

| Pole         | Treść                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | Mapowanie chunków na wiersze i reguła „przy update najpierw skasuj stare" są kopiowane w każdym wywołującym `EmbeddingService`.                                        |
| **Dowód**    | `memory.service.ts:225`, `:380`, `:807`, `memory-admin.service.ts:454`, `:512`, `proposals.service.ts:989`, `cli/reembed.command.ts:91`                                |
| **Powoduje** | Kształt już się rozjeżdża (jedno miejsce mapuje `c.chunkIndex`, reszta `c.index`); dodanie pola to 7 punktów edycji, a pominięcie jednego psuje wyszukiwanie po cichu. |
| **Fix**      | `writeStaging(tx, proposalId, embedded)` i `replaceMemoryEmbeddings(tx, memoryId, embedded)` przyjmujące executor.                                                     |
| **Koszt**    | M                                                                                                                                                                      |

### 10. Typy SPA jako ręczne lustro enumów serwera 🟠

| Pole         | Treść                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | `types/domain.ts` świadomie przepisuje enumy serwera bez importu cross-package i jedna kopia jest już nieaktualna (brak `withdrawn`). |
| **Dowód**    | `apps/dashboard/src/types/domain.ts:11` vs `apps/server/src/db/schema/enums.ts:23`                                                    |
| **Powoduje** | TS w SPA twierdzi, że `'withdrawn'` jest niemożliwe, więc `switch` na statusie propozycji będzie „wyczerpujący" i padnie w runtime.   |
| **Fix**      | Uzupełnić wartość i dołożyć test parytetu porównujący `enumValues` z listami w `types/domain.ts`, żeby rozjazd padał na CI.           |
| **Koszt**    | S                                                                                                                                     |

### 11. `apps/dashboard` bez runnera testów 🟠

| Pole         | Treść                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | Brak skryptu `test` w `apps/dashboard/package.json` sprawia, że `pnpm verify` (`… && pnpm -r test`) jest po cichu server-only.                           |
| **Dowód**    | `apps/dashboard/package.json:7`, niepokryte `apps/dashboard/src/lib/text-diff.ts:48`                                                                     |
| **Powoduje** | `computeInlineWordDiff` z czterema progami fallbacku jest uruchamiany wyłącznie w przeglądarce — a to ekran, na którym człowiek decyduje approve/reject. |
| **Fix**      | Dodać vitest + skrypt `test` (jsdom zbędny, to czysty node) i testy `text-diff`; obejmie przy okazji `format.ts`, `errors.ts`, `query-string.ts`.        |
| **Koszt**    | M                                                                                                                                                        |

### 12. Throttle logowania bez testu 🟠

| Pole         | Treść                                                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | Jedyna bariera przed brute-force współdzielonego hasła nie ma testu; `token-bucket.spec.ts` pokrywa samą klasę, nie tę ścieżkę.                                                                       |
| **Dowód**    | `apps/server/src/dashboard/auth/login-throttle.service.ts:21`, `apps/server/src/dashboard/auth/auth.controller.ts:40`                                                                                 |
| **Powoduje** | Nieprzybite są dwie regresje w zasięgu ręki: fallback `?? 'unknown'` przy złym `trust proxy` (jeden bucket na całą instalację albo bucket per podrobiony nagłówek) i kolejność throttle-przed-hasłem. |
| **Fix**      | Test serwisu na fake timerach (6. próba, izolacja IP, odnowa okna) + test kontrolera na atrapach: 429 nie sprawdza hasła i ustawia `Retry-After`.                                                     |
| **Koszt**    | S                                                                                                                                                                                                     |

### 13. Granica portów MCP/dashboard bez testu 🟠

| Pole         | Treść                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | `createSurfaceMiddleware` — jedyna obrona poza proxy — nie występuje w `apps/server/test/` ani razu.                                      |
| **Dowód**    | `apps/server/src/dashboard/surface.middleware.ts:18`, montowany w `apps/server/src/main.ts:81`                                            |
| **Powoduje** | Czysta funkcja z rozgałęzieniem na `localPort` i dwiema politykami cicho pęka przy refaktorze, wystawiając `/api/*` na publicznym porcie. |
| **Fix**      | `test/surface.middleware.spec.ts` z macierzą portów × ścieżek na atrapach `{socket:{localPort}, path}` — bez Nesta i bez bazy.            |
| **Koszt**    | S                                                                                                                                         |

### 14. `pnpm audit` nie może być bramką 🟢

| Pole         | Treść                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | `react-router` 7.18.1 jest pod advisory high (GHSA-qwww-vcr4-c8h2), więc `pnpm audit` zwraca niezerowy wynik.                                                                                                          |
| **Dowód**    | `apps/dashboard/package.json:36`, konsument `apps/dashboard/src/App.tsx:61`                                                                                                                                            |
| **Powoduje** | Samo advisory jest u nas niewykorzystywalne (dotyczy trybu RSC, mamy kliencki `BrowserRouter` bez SSR) — ale blokuje wpięcie audytu do `verify`, więc następne advisory, już trafiające w kod, przejdzie niezauważone. |
| **Fix**      | Wyciszyć w `pnpm.auditConfig.ignoreGhsas` z linkiem do uzasadnienia i dodać `pnpm audit --audit-level=high` do `verify`.                                                                                               |
| **Koszt**    | S                                                                                                                                                                                                                      |

### 15. Odwrócona zależność ESLint w dashboardzie 🟢

| Pole         | Treść                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Objaw**    | Pakiet deklaruje dwa pluginy ESLint, których sam nie importuje (ładuje je rootowy konfig), a nie deklaruje `eslint`, mimo skryptu `lint`. |
| **Dowód**    | `apps/dashboard/package.json:49`, `eslint.config.mjs:3`                                                                                   |
| **Powoduje** | Binarka `eslint` działa tylko jako peer tych pluginów, więc usunięcie „nieużywanych" zależności wywali `lint` z „command not found".      |
| **Fix**      | Usunąć oba pluginy i albo dodać jawnie `eslint` do devDeps, albo skasować skrypt (rootowe `eslint .` i tak pokrywa `src/`).               |
| **Koszt**    | S                                                                                                                                         |

---

## Zrobione

| Ustalenie                              | Data       | Co zrobiono                                                                                                                                                      |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dryf kontraktu `save_memory` w kanonie | 2026-07-29 | §5 opisywał `(header, body, tags)` i „agent tylko tworzy", §4 — `event` jako human-only; przepisane wraz z formułą hasha i komentarzem w `db/schema/enums.ts:3`. |
| Enumy statusów niepełne w §4           | 2026-07-29 | Dopisane `memories.purged` i `proposals.withdrawn` z „kto je ustawia" i ostrzeżeniem, że predykat „wszystko poza `approved`" jest niepoprawny.                   |
| Relacje opisane jako forward-compat    | 2026-07-29 | `memory_relations` i graph boost wyprowadzone z §4-forward-compat i §13 do właściwego §4; §6 dostał brakujący krok „post-fuzja: age-decay × graph boost".        |
| §12 udawał kompletną listę configu     | 2026-07-29 | Tabela (~24 z 54 zmiennych) dostała jawną adnotację „niekompletna, kanon to `.env.example` + `config/env.ts`" i wyliczenie pominiętych rodzin.                   |

---

## Odrzucone

Świadoma decyzja „nie robimy" — ze śladem „dlaczego", żeby temat nie wracał co przegląd.
Ta tabela jest częścią listy wykluczeń przy następnym uruchomieniu skilla.

_Pusto — w przeglądzie 2026-07-29 nie odrzucono żadnego ustalenia._
