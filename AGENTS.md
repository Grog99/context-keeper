# AGENTS.md — wskazówki dla agentów AI w tym repo

> Jedno źródło prawdy dla wszystkich agentów (Claude Code, Codex, Cursor, …). Claude Code nie
> wczytuje `AGENTS.md` automatycznie — [`CLAUDE.md`](CLAUDE.md) zaciąga ten plik przez `@AGENTS.md`.

## Pamięć projektu — używaj context-keeper (MCP)

Ten projekt **dogfooduje własną instancję** jako trwałą pamięć projektu. Pamięć jest wystawiona
jako serwer MCP `context-keeper` (skonfigurowany w commitowanym [`.mcp.json`](.mcp.json)).
Narzędzia: `mcp__context-keeper__search_memory`, `get_memory`, `save_memory`.

**Tryb pracy: proaktywny.**

- **Na starcie zadania** wołaj `search_memory`, żeby pobrać istotny kontekst projektu (decyzje,
  konwencje, specyfikę środowiska) — zanim zaczniesz zgadywać.
- **Gdy pojawi się nieoczywista decyzja lub konwencja**, sam proponuj ją przez `save_memory`,
  bez czekania na polecenie.

**Higiena pamięci:**

- Zapisuj tylko fakty **niewyprowadzalne z repo** — decyzje, konwencje zespołu, „dlaczego tak",
  specyfikę deploymentu. **Nie** wrzucaj rzeczy, które są już w `README.md`, `context/` czy `docs/`
  (stack, architektura, split powierzchni) — agent to sobie przeczyta.
- Pełny kontrakt (human-gate, odrzucanie sekretów, statusy zwrotne, limity) niosą **opisy narzędzi
  MCP** — tu tylko: kiedy sięgać i co zapisywać.

**Co zapisywać, jako jaki `kind`:**

- `fact` (domyślny) — jeden atomowy, samodzielny fakt: decyzja, konwencja zespołu, „dlaczego tak",
  specyfika deploymentu.
- `document` — dłuższy, samodzielny tekst referencyjny zapisywany w całości (decyzja, spec,
  opis konwencji). Przekaż `kind: "document"`.
- `event` — zdarzenie epizodyczne: co się wydarzyło i kiedy (deploy, incydent, decyzja podjęta
  na spotkaniu). Przekaż `kind: "event"` **oraz** `event_time` (ISO 8601, np.
  `2026-07-28T14:30:00Z`) — `event_time` jest **wymagany**, nie ma domyślnego „teraz"; to czas
  ZDARZENIA, nie zapisu. Backdate bez ograniczeń, daty przyszłe dozwolone. Poprawienie już
  zapisanego zdarzenia (w tym jego `event_time`) zostaje po stronie człowieka — `supersedes`
  nie działa na eventy.
- Żeby poprawić coś, co już jest w pamięci, znajdź to przez `search_memory` i zapisz ponownie z
  `supersedes: <id>` — zamiast dokładać luźny duplikat.
- Żeby powiązać zapisywaną pamięć z inną już istniejącą, dołóż `relations: [{type, targetId}]`
  (`caused_by` | `follows` | `context_for`, max 16) — trafia do tego samego proposala.

## Zasady pracy

Zebrane z audytu transkryptów sesji ([`agent-patterns-report.md`](context/agent-patterns-report.md))
— powtarzające się błędy i wzorce, warte zapobiegawczego uwzględnienia:

- **Weryfikacja:** po nietrywialnej zmianie odpal `pnpm verify` (lint + typecheck + test dla
  całego monorepo) zamiast ręcznie sklejać `pnpm lint` / `tsc --noEmit` / `pnpm -r test` za
  każdym razem.
- **Duże zadania:** faza typu „cała implementacja w jednym ciągłym przebiegu subagenta" (setki
  tysięcy tokenów, dziesiątki użyć narzędzi) zwiększa ryzyko dryfu kontekstu i zostawia mało
  naturalnych punktów na przegląd. Rozdzielaj plan → implementację → weryfikację na osobne
  przebiegi z checkpointem człowieka pomiędzy, zamiast jednego maratonu.
- **Raporty subagentów:** zanim użyjesz `plik:linia` zacytowanego w raporcie subagenta, zweryfikuj
  je w źródle — subagenci potrafią podać niespójny numer linii.
- **Przeglądarka (`Claude_Browser`):** `read_page` jako pierwszy krok każdej nowej interakcji,
  zanim `find`/`form_input`/`click` — drzewo strony musi być scache'owane. Przed `screenshot`
  upewnij się, że pane jest faktycznie widoczna/otwarta.
- **`Edit` po `Read`:** jeśli między odczytem a edycją poszedł build/lint/format (mógł zmienić
  plik na dysku), zrób re-read przed `Edit` — `old_string` mógł już nie pasować.
- **Narzędzia:** nie zgaduj nazw narzędzi (np. `Grep`, nie `Grag`) — sprawdź, co faktycznie jest
  dostępne, zamiast zakładać.
- **Grep/ripgrep na Windows:** w patternie używaj `/` albo escapuj `\`, nawet wklejając ścieżkę z
  Windows — nieescapowany backslash w regexie ripgrepa jest błędem. Egzekwowane hookiem
  (`.claude/hooks/grep-windows-path-guard.mjs`): pattern wyglądający jak wklejona ścieżka Windows
  jest blokowany z podpowiedzią.
- **Nowy `git worktree`:** `pnpm install` w nowym katalogu uruchamia się automatycznie po
  `git worktree add` (hook `.claude/hooks/worktree-install.mjs`) — nie trzeba pamiętać ręcznie.

---

> **Setup połączenia** (token w zmiennej `CONTEXT_KEEPER_TOKEN`, restart, akceptacja serwera) —
> to czynności dla człowieka, opisane w [`README.md`](README.md), sekcja „Pamięć projektu (dogfooding)".
