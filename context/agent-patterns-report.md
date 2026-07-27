# Context Keeper — Wzorce pracy agentów (raport z transkryptów)

Analiza transkryptów sesji Claude Code nad tym repo: co się powtarza, jakie błędy wracają, co
mogłoby być skillem/regułą. Nie jest to audyt kodu — to audyt *jak agenci pracowali*, żeby
poprawić `AGENTS.md`/`CLAUDE.md` i ewentualne skille na przyszłość.

**Aktualizacja:** 2026-07-24.

**Zakres:** 31 sesji głównych (branch `main`, ~16 MB, 157 plików JSONL łącznie z podwątkami
subagentów) + 8 sesji z 4 folderów `git worktree` tego repo (22 pliki). Łącznie ~40 unikalnych
`session_id`, 179 plików.

**Metoda:** bez czytania surowych transkryptów przez agentów. Skrypt `analyze_sessions.py`
(skill `session-analyzer`) strumieniowo sparsował JSONL i policzył sygnały (błędy narzędzi,
tarcie z uprawnieniami, presję użycia, powtarzane komendy/odczyty, niejasne handoffy). Przy
okazji dopisałem do tego skryptu — globalnie, w `~/.claude/skills/session-analyzer/` — polskie
warianty regexów oraz zupełnie nową kategorię `user_correction` (korekty użytkownika), bo
oryginalne regexy były wyłącznie angielskie. Na skondensowanych, przefiltrowanych już przez
skrypt "chunkach" ewidencji pracowało 7 równoległych agentów Haiku (po jednym na typ sygnału) —
wyciągały konkretne wzorce i cytowały `plik:linia`. Ja (Sonnet) połączyłem to w jedną całość
poniżej, plus doszedłem samodzielnie (bez agenta) do jednego dodatkowego sygnału: częstości
użycia narzędzi MCP `context-keeper`.

---

## 1. Najważniejsze ustalenie: proaktywność `context-keeper` nie działa jak zakładano

`AGENTS.md` nakazuje tryb proaktywny — `search_memory` na starcie zadania, `save_memory` przy
nieoczywistej decyzji, bez czekania na polecenie. W praktyce narzędzia
`mcp__context-keeper__{search,get,save}_memory` pojawiły się w **3 z 31** sesji głównych (~10%)
i w 5 z 8 sesji worktree. W pozostałych ~90% sesji agent w ogóle nie sięgnął po pamięć projektu,
mimo że w tym repo jest ona jedynym miejscem na "dlaczego tak", konwencje zespołu i specyfikę
deploymentu, które nie wynikają z samego kodu.

To nie jest zaskoczenie odkryte od zera — [`backlog.md`](backlog.md) już zawiera pozycję
"Plugin Claude Code ⏸️ — bundle: config połączenia + skill proaktywności", warunkowaną właśnie
tym: *"budujemy tylko, jeśli instrumentacja pokaże, że czysty MCP + `AGENTS.md` nie wymuszają
proaktywnego recallu."* Ta analiza jest dokładnie tym pomiarem. Wynik: instrukcja tekstowa w
`AGENTS.md` sama w sobie nie wystarcza — dogfooding potwierdza przesłankę z backlogu.

**Rekomendacja:** odznaczyć warunek w backlogu jako spełniony i rozważyć realizację pozycji
"skill proaktywności" (np. lekki hook/skill, który na starcie sesji przypomina o
`search_memory`, zamiast polegać wyłącznie na instrukcji w `AGENTS.md`).

---

## 2. Pozostałe ustalenia, w kolejności

### 2.1. Weryfikacja (lint/typecheck/test) jest ręczna i za każdym razem inna

`repeated_commands` pokazuje te same polecenia wpisywane od nowa w wielu sesjach, z drobnymi
wariantami (`tail -100` / `tail -200` / `head -200`): `pnpm lint`, `pnpm -r test`,
`npx tsc --noEmit`, `npx eslint`, `docker ps`/`docker info`. Przykłady:
`020d0bd5-2236-4087-910a-61944feef9a6/subagents/agent-a31207747d2b0a38c.jsonl:60` (lint),
`fd64a07a-c2ff-4a58-8c50-f6aacd9206bd/subagents/agent-a8a325949f46bb163.jsonl:525,533`
(eslint + tsc pod rząd), `2aaabca0-.../agent-a98e9aa3eda4a0cd2.jsonl:71,118` (tsc + docker).

Globalny `CLAUDE.md` już każe uruchamiać testy/typecheck/lint po nietrywialnej zmianie — dzieje
się to konsekwentnie, ale za każdym razem jako osobno sklejana komenda. **Kandydat na
skill/skrypt:** jedna komenda weryfikacyjna (np. `pnpm verify` w root `package.json`) spinająca
lint+typecheck+test dla monorepo, żeby nie odtwarzać jej ręcznie za każdym razem.

### 2.2. Błędy narzędzi — 7 powtarzających się wzorców (kandydaci na reguły)

Z sygnału `tool_errors` (Haiku, ~40 błędów zmapowanych na wzorce):

1. **Screenshot przeglądarki bez otwartej/widocznej pane** (~8x) — rule candidate: zawsze
   sprawdzić, czy pane przeglądarki jest widoczna, zanim zrobi się `screenshot`.
2. **Brak `pnpm install` w świeżym `git worktree`** (~6x) — narzędzia CLI (`drizzle-kit`, `tsc`)
   "not recognized", bo zależności nie zostały zainstalowane po utworzeniu worktree. Recurring
   mistake, nie rule — łatwo naprawić: zainstalować zależności jako pierwszy krok w nowym
   worktree.
3. **Windows-owe ścieżki z backslashem wklejane wprost w pattern Grep/ripgrep** (~4x) — ripgrep
   odrzuca unescaped `\`. Rule candidate: w patternach Grep/ripgrep używać `/` albo escapować
   backslash, nawet na Windows.
4. **Interakcja z przeglądarką bez wcześniejszego `read_page`** (~8x, głównie w worktree)
   — `find`/`form_input`/`click` zawodzą, bo drzewo strony nie jest jeszcze scache'owane. Rule
   candidate: `read_page` zawsze jako pierwszy krok każdej nowej interakcji z przeglądarką.
5. **`Edit` na pliku zmienionym od czasu `Read`** (~3x) — formatter/linter zmienia plik między
   odczytem a edycją, `old_string` już nie pasuje. Rule candidate: re-read przed `Edit`, jeśli
   między `Read` a `Edit` uruchamiano build/lint/format.
6. **Escapowanie backticków/cudzysłowów przy dynamicznym budowaniu kodu JS/TS w stringu** (~4x).
7. **Halucynowane/błędnie nazwane narzędzia** (np. `mark_chapter` niedostępne, `Grag` zamiast
   `Grep`, ~3x) — recurring mistake: sprawdzać faktycznie dostępne narzędzia zamiast zgadywać.

### 2.3. Ciężkie, jednorazowe przebiegi faz (plan→implementacja→weryfikacja w jednym skoku)

`usage_pressure` (próg: ≥40k tokenów / ≥120s / ≥25 użyć narzędzia) pokazuje spójny wzorzec:
duże fazy (Faza 4 kolejka akceptacji, Faza 6 nocny job, Faza 7 backup/restore) są robione jako
**jeden ciągły przebieg subagenta** obejmujący całą implementację (100k–257k tokenów, 50–100 użyć
narzędzi, 8–22 minuty), np. `06681b35-...:107` (235k tokenów), `dffa257b-...:131` (257k tokenów).
To nie jest błąd, ale zwiększa ryzyko: więcej okazji na dryf kontekstu i mniej naturalnych
punktów na przegląd w połowie roboty. **Rekomendacja:** rozbijać duże fazy na osobne etapy
(plan → implementacja → weryfikacja jako oddzielne przebiegi subagenta) z checkpointem
człowieka pomiędzy, zamiast jednego maratonu.

### 2.4. Hotspoty odczytywanych plików

`repeated_file_reads`: `memory.service.ts` (45x/9 sesji), `context/prd.md` i
`context/tech-stack.md` (34x/3 sesje — plus osobno liczone warianty ścieżki z `/` i `\`, patrz
§4), `apps/server/src/db/schema/enums.ts` (33x/12 sesji), `memory.integration.spec.ts` (30x/7),
`context/roadmap.md` (20x/11). Pliki w `context/` już pełnią rolę mapy projektu i są faktycznie
konsultowane — to dobry znak. Wysoka częstość odczytu `memory.service.ts` i `enums.ts` sugeruje,
że krótkie streszczenie ich struktury (kluczowe metody/enumy) w jednym z istniejących dokumentów
`context/` mogłoby ograniczyć część pełnych odczytów.

### 2.5. Nowa kategoria `user_correction`: mało danych, ale działa

6 trafień w sesjach głównych, po weryfikacji: 2 prawdziwe korekty, 4 fałszywe trafienia (kod/diff
zawierający słowa-klucze, komunikaty o zatwierdzeniu planu). Obie prawdziwe korekty już są
zaadresowane:
- decyzja z tej właśnie sesji analitycznej (napraw regexy globalnie w skillu — już zrobione,
  patrz metoda wyżej),
- decyzja z sesji `cdf4a250-9a52-4bd6-8da8-a48959772b60:85` ("nie commituj testu, jeśli nie
  wiadomo co dokładnie dowodzi") — to dokładnie pułapka opisana już w pamięci projektu jako
  *ungameable-test RRF* (Faza 3, Retrieval).

Niska liczba realnych korekt to dobry znak (rzadko trzeba poprawiać agenta) — ale kategoria jest
nowa i ma mały scoring window (tylko `main`, worktree'y miały 0 trafień), więc na razie potraktuj
jako sygnał do obserwacji w kolejnych analizach, nie jako twardy wniosek.

### 2.6. Kategorie w większości szumiące (regexy złapały nie to, co miały)

- **`permission_friction`** — ~85-90% to słownictwo domenowe (`approved`/`gated`/`permission` w
  kontrakcie narzędzi MCP, enumach statusów propozycji, design tokenach UI), nie realne momenty
  zatwierdzania. Prawdziwe tarcie: klasyfikator auto-mode Claude Code odmówił akcji
  (`020d0bd5-2236-4087-910a-61944feef9a6/subagents/agent-a92e5d5bd78268d41.jsonl:111,117,120`) i
  uprawnienia plików w Dockerze (EACCES, 2-3x). To dokładnie ten sam typ fałszywego trafienia,
  jaki wcześniejszy przykładowy raport tego skilla już opisywał jako znane ograniczenie.
- **`unclear_handoffs`** — ~35 trafień, w większości to terminologia skilla `plan-implement`
  ("quick-clarify" jako nazwany krok procesu) albo udokumentowane z góry decyzje w `roadmap.md`
  ("ustalone z góry, żeby nie pytać ponownie") — czyli sygnał dobrej praktyki, nie confusion.
  Realna niejasność: 2-3 przypadki, wszystkie to zamierzone pytania przed nieodwracalną akcją
  (np. potwierdzenie commita na `main`).
- **`context_churn`** — tylko 8 trafień, w większości pozorne (dopasowania do fragmentów kodu, a
  nie realnych komunikatów o presji tokenów). Zbyt mała próbka, by wyciągać wniosek.
- **`long_debug_loops`** — 2 pliki, głównie wielo-agentowa koordynacja (Faza 6, nocny job), nie
  klasyczne utykanie w pętli. Przy okazji audytu wypłynęły dwa realne, wciąż otwarte tematy w
  kodzie: brak statusu `'withdrawn'` w `apps/dashboard/src/components/StatusChip.tsx:6` i
  `apps/dashboard/src/types/domain.ts:11`, oraz możliwy wyścig TOCTOU w
  `apps/server/src/nightly/nightly.service.ts:298-322` (`findNeighborPairs` względem
  `factById`). To poboczne znalezisko tego audytu, nie wzorzec zachowania agenta — warto to
  zweryfikować osobno, nie jako część tego raportu.

Jeden konkretny kandydat na regułę z tej sekcji: **przed użyciem `plik:linia` z raportu
subagenta, zweryfikuj je w źródle** — bo w Fazie 6 główny agent musiał ręcznie poprawiać
niespójne numery linii zgłaszane przez subagentów.

---

## 3. Skróty do wdrożenia (ranking)

1. Odhaczyć/zweryfikować warunek w `backlog.md` dot. proaktywności `context-keeper` (§1).
2. Dodać jedną komendę weryfikacyjną spinającą lint+typecheck+test (§2.1).
3. Reguła: `read_page` przed każdą interakcją z przeglądarką; sprawdź widoczność pane przed
   `screenshot` (§2.2 poz. 1 i 4).
4. Reguła: `pnpm install` jako pierwszy krok po wejściu do nowego `git worktree` (§2.2 poz. 2).
5. Reguła: w dużych fazach rozdzielać plan/implementację/weryfikację na osobne przebiegi z
   checkpointem (§2.3).
6. Reguła: zweryfikuj `plik:linia` z raportu subagenta przed użyciem (§2.6).

---

## 4. Ograniczenia tej analizy — bez cichego obcinania

- Kilka list w `main` osiągnęło limit skryptu `MAX_EVIDENCE_PER_GROUP=25` (`tool_errors`,
  `permission_friction`, `unclear_handoffs`, `long_debug_loops` po stronie liczników cząstkowych)
  — realna liczba wystąpień może być wyższa niż pokazana.
- `repeated_file_reads` liczy tę samą ścieżkę osobno, jeśli w transkryptach występuje raz z `/`,
  raz z `\` (np. `context/tech-stack.md` policzone jako 34x i 21x pod dwoma różnymi kluczami) —
  to ogranicznie samego skryptu, nie odkryty wzorzec pracy; realne liczby dla tych plików są
  sumą wariantów.
- `project_agent_patterns` w większości pokazuje `agent_name: unknown-agent` dla sesji głównych
  — to znana, udokumentowana w samym skillu niedokładność metadanych, nie próbowałem zgadywać
  nazw agentów.
- Kategoria `user_correction` jest nowa (dodana w ramach tej analizy) i miała tylko jedną sesję
  z realnymi trafieniami — potraktuj jej wnioski jako wstępne, nie ostateczne.
- Ekstrakcję dowodów robiły modele Haiku (tanie, ale mniej precyzyjne niż głębsza weryfikacja)
  — dla `context_churn` opis "dlaczego coś jest szumem" był niepewny; przed podjęciem decyzji
  opartej na tej kategorii warto ręcznie zerknąć do `chunks/context-churn-*.md`.
- Surowe artefakty (`manifest.json`, `turns.jsonl`, `signals.json`, `chunks/*.md` dla wszystkich
  5 przebiegów) zostały w tymczasowym katalogu scratchpad tej sesji, nie w repo — nie zawierają
  długich cytatów z promptów/outputów (skrypt obcina i tak podgląd tekstu), ale i tak nie ma
  powodu trzymać ich długoterminowo poza repo; ten plik jest jedynym trwałym artefaktem.

## 5. Skrypt: co poprawiono globalnie w `session-analyzer`

W `~/.claude/skills/session-analyzer/scripts/analyze_sessions.py`:
- Rozszerzono `ERROR_RE`, `PERMISSION_RE`, `CONTEXT_RE`, `UNCLEAR_RE` o polskie warianty (były
  wyłącznie angielskie).
- Dodano nową kategorię sygnału `CORRECTION_RE` → `user_correction` (PL+EN), ograniczoną do
  wiadomości `role=="user"`, żeby nie łapać cytatów tych słów w treści zwracanej przez narzędzia.
- Self-test skryptu (`--self-test`) przechodzi po zmianach; działa to teraz dla każdego projektu
  analizowanego tym skillem w przyszłości, nie tylko dla tego repo.
