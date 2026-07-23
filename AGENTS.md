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
- **Jeden atomowy fakt na wywołanie** `save_memory`. Nie pakuj wielu niezwiązanych faktów naraz.
- Zapisy są **human-gated** — `save_memory` tworzy *propozycję* w kolejce, do pamięci trafia dopiero
  po akceptacji w dashboardzie. To fire-and-forget: nie odpytuj i nie czekaj na akceptację.
- **Nigdy sekretów** (klucze, hasła, tokeny) w treści — serwer odrzuca je jako `secret_blocked`.
  Odnoś się do sekretu po nazwie/przeznaczeniu, nie po wartości.

---

> **Setup połączenia** (token w zmiennej `CONTEXT_KEEPER_TOKEN`, restart, akceptacja serwera) —
> to czynności dla człowieka, opisane w [`README.md`](README.md), sekcja „Pamięć projektu (dogfooding)".
