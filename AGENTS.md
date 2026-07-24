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
- Żeby poprawić coś, co już jest w pamięci, znajdź to przez `search_memory` i zapisz ponownie z
  `supersedes: <id>` — zamiast dokładać luźny duplikat.
- `event` jest human-only — agent go nie tworzy.

---

> **Setup połączenia** (token w zmiennej `CONTEXT_KEEPER_TOKEN`, restart, akceptacja serwera) —
> to czynności dla człowieka, opisane w [`README.md`](README.md), sekcja „Pamięć projektu (dogfooding)".
