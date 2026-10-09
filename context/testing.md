# Context Keeper — konwencja testów (serwer)

**Zakres:** `apps/server` · **Wiąże:** każdego agenta i człowieka piszącego testy · **Strategia i uzasadnienie:**
[`tech-stack.md`](tech-stack.md) §15 · **Etap test-first w workflow:** [`plan-implement`](../.claude/skills/plan-implement/SKILL.md)

> Ten plik trzyma **reguły**: co testować, czego nie, co mockować, gdzie leżą testy i jak się nazywają.
> Dashboard (`apps/dashboard`) nie ma runnera ani testów — jego sekcję dopisze pozycja roadmapy „Luki w testach".

## 1. Zasada ogólna

Testy piszemy tam, gdzie się opłacają — **nie dla pokrycia**. Nie ma progu coverage. Każdy test kosztuje czas
na każdym PR (`pnpm verify` to wymagany check w CI), więc każdy ma przybijać **zachowanie** obserwowalne przez
publiczne API serwisu, narzędzia MCP albo migracji — nie szczegół implementacji.

## 2. Co testować (priorytety)

1. **Human-gate:** transakcja akceptacji (create / update / merge / delete) i optimistic-concurrency stale-check.
2. **Scope i auth:** IDOR między projektami, token projektu vs token konta, rozwiązywanie projektu z nagłówka,
   cykl życia tokenów (hash, rotacja, unieważnienie), sesja i CSRF dashboardu.
3. **Kontrakt MCP:** odpowiedzi narzędzi, koperta błędu i jej `code`, statusy zwrotne — e2e przez oficjalny SDK
   (`helpers/mcp-app.ts`, `helpers/mcp-client.ts`).
4. **Retrieval:** RRF, collapse, decay, graph boost, filtr aktywnego modelu, fallback FTS.
5. **Migracje:** upgrade na niepustej bazie (`helpers/migrations.ts`, `migrateUpTo`).

Dalej: skaner sekretów na korpusie fixture oraz nocny job (idempotencja, lock, fail-open).

Gdy zadanie zmienia zachowanie istniejącego testu, ten test należy do listy testów zadania — to nie jest
sprzątanie buildera.

## 3. Czego nie testować

- **Kontrolerów-przelotek** (handler tylko woła serwis) — logikę testuj na serwisie; routing, guardy i walidację
  pokrywa e2e albo istniejące testy metadanych (`dashboard-inputs.coverage.spec.ts`).
- **Kształtu DTO / schematu zod pole po polu** — testuj reguły (limity, odrzucenia), nie przepisanie schematu.
- **Snapshotów** (`toMatchSnapshot`, duże inline snapshoty) obiektów czy promptów — asertuj konkretne pola.
- **Prywatnych helperów bez publicznego API** — testuj przez metodę publiczną. Wyjątek: `vi.spyOn` na instancji
  tylko po to, żeby wstrzyknąć awarię (wzorzec fail-open, np. `nightly as unknown as …`).
- **Kodu frameworka i bibliotek** (DI i dekoratory Nesta, drizzle, zod, pg).
- **Stałych i configu przepisanych 1:1 do testu.** Dozwolone są testy parytetu dwóch źródeł prawdy
  (np. `compose-env-parity.spec.ts`).
- **Trywialnych getterów i mapowań** bez logiki.
- **Tego samego zachowania na kilku warstwach** — wybierz najniższą, która je naprawdę widzi (reguła zakresu w
  integration, e2e sprawdza tylko kontrakt).
- **Samych fake'ów i helperów testowych.**
- **Dokładnego brzmienia komunikatów i logów**, o ile nie są kontraktem (`code` błędu MCP, opisy narzędzi).
- **Wydajności, obciążenia, timingów** (poza v1).

## 4. Gdzie leżą testy i jak się nazywają

Wszystkie testy serwera leżą płasko w `apps/server/test/`, kod wspólny w `apps/server/test/helpers/`.
**Bez kolokacji** w `src/`, choć `vitest.config.ts` ją dopuszcza. Plik nazywa się od modułu / funkcji:

| Sufiks | Warstwa | Jak działa |
| ------ | ------- | ---------- |
| `*.spec.ts` | unit | serwisy składane ręcznie, bez bazy; rolę w nazwie pliku wolno zostawić (`*.controller.spec.ts`, `*.guard.spec.ts`, …) |
| `*.integration.spec.ts` | integration | Postgres z testcontainers (`pgvector/pgvector:pg18-trixie`) + prawdziwe migracje, kontener per plik |
| `*.migration.spec.ts` | migracja | upgrade z N-1 przez `migrateUpTo` na niepustej bazie |
| `*.e2e.spec.ts` | e2e | Nest in-process + klient oficjalnego SDK MCP |

Odstępstwa `dashboard-validation.http.spec.ts` i `dashboard-inputs.coverage.spec.ts` są **tolerowane, nie są
wzorcem** — nowy test bierze sufiks z tabeli. Nazwy `describe` / `it` po polsku, z odniesieniem do wymagania
(FR-…, AC…), jak w istniejących specach.

Jeden przebieg vitest: `pnpm verify` albo `pnpm --filter @context-keeper/server test`. Integration, migration i
e2e wymagają **Dockera** (testcontainers); wersja Node z `.nvmrc`. E2e wchodzi przez `AppModule`, który czyta
`.env` z korzenia repo (`env.ts`, `DOTENV_FALLBACKS`) — lokalny `.env` może zmienić wynik.

## 5. Co i jak mockować

- **Domyślnie ręczny fake implementujący port.** `StubEmbeddingProvider`, `HealthStubEmbeddingProvider` i
  `FakeLlmProvider` żyją w `helpers/fakes.ts` — **używaj ich, nie kopiuj do speca**. Fake dla nowego portu też
  trafia do `helpers/fakes.ts`.
- **Providery HTTP:** `vi.stubGlobal('fetch', …)` (przywróć po teście); `vi.spyOn(globalThis, 'fetch')`, gdy
  test ma udowodnić, że do sieci nie wyszło nic.
- **Awarie** wstrzykuj flagą fake'a (`throwOnEmbed`, responder zwracający `Error`) albo `vi.spyOn` na instancji.
- **Bazy nie mockujemy:** prawdziwy Postgres z testcontainers — transakcje i CHECK-i są rdzeniem poprawności.
  Tolerowane wyjątki to wąskie testy jednostkowe kontrolera, który tylko czyta jeden licznik
  (`fakeDb` w `metrics.controller.spec.ts`) i test dowodzący, że ścieżka w ogóle nie sięga do bazy
  (`untouchableDb` w `near-duplicates.spec.ts`).
- **Unikaj `vi.mock` modułów** (wyjątek: `nightly-llm-conflicts.integration.spec.ts`) i
  `Test.createTestingModule` (wyjątek: `dashboard-validation.http.spec.ts`). Serwisy składaj ręcznie
  (`helpers/services.ts`).

## 6. Bugfix zaczyna się od testu

W **każdej** sesji, także ad hoc: najpierw test odtwarzający błąd na najniższej warstwie, która go widzi —
uruchom go i zobacz, że pada; dopiero potem poprawka. Test zostaje jako regresja.

**Wyjątek:** gdy błędu nie da się odtworzyć testem za rozsądną cenę (np. występuje tylko na deploymencie),
napisz w opisie PR dlaczego.

## 7. Test-first w `plan-implement`

Mechanika (komendy, kontrola git) jest w [`SKILL.md`](../.claude/skills/plan-implement/SKILL.md); tu tylko zasada:

- Plan ma sekcję **„Testy"**: zachowania do przybicia, każde oznaczone **czerwony** (nowe lub zmienione
  zachowanie — test musi paść przed implementacją; pad na brakującym imporcie się liczy) albo **strażnik**
  (zachowanie, które ma przetrwać zmianę, np. refaktor — zielony od początku), albo jawne „brak testów, bo…".
  Człowiek akceptuje tę sekcję razem z planem.
- Osobny test-writer (Opus) pisze dokładnie tę listę, nie dotyka `src/` i jej nie rozszerza. Orkiestrator
  sprawdza czerwień i zieleń, po czym zamraża testy w indeksie git (`git add`) jako snapshot.
- Builder (Sonnet) testów nie edytuje; testy, które uważa za błędne, zgłasza w raporcie. Defekt testu trafia do
  świeżego test-writera albo człowieka, defekt kodu do buildera. Recenzja Codexa ocenia testy względem „Testów".
- Podział ról obowiązuje **tylko w `plan-implement`** — w sesji ad hoc wiąże reguła z §6.
