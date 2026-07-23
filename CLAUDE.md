# CLAUDE.md — wskazówki dla agentów AI w tym repo

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

## Setup na nowym urządzeniu

`.mcp.json` jedzie z repo, ale token musisz podać lokalnie (nie ma go w repo — leży w zmiennej
środowiskowej `CONTEXT_KEEPER_TOKEN`):

```powershell
setx CONTEXT_KEEPER_TOKEN "ck_...twoj_klucz_z_dashboardu..."
```

Potem zrestartuj terminal i Claude Code (żeby wczytał zmienną i `.mcp.json`) oraz zaakceptuj serwer
`context-keeper` przy pierwszym uruchomieniu. Endpoint: `https://ck-mcp.dgolczewski.pl/mcp`
(health, publiczny: `https://ck-mcp.dgolczewski.pl/health`). Na Linux/macOS ustaw zmienną w profilu
powłoki (`export CONTEXT_KEEPER_TOKEN=...`).
