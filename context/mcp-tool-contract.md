# Context Keeper — kontrakt narzędzi MCP (warstwa 1)

**Status:** v1 (Faza 2) · **Źródło:** [`prd.md`](prd.md) §6.1, [`tech-stack.md`](tech-stack.md) §5, §14

> To jest **warstwa 1** trzywarstwowego kontraktu z agentem (tech-stack §14): opisy narzędzi
> niesione przez `tools/list`, widoczne automatycznie dla **każdego** klienta MCP — bez pluginu,
> bez wklejki do `CLAUDE.md`/`AGENTS.md`. Load-bearing polityka (w tym "nie zapisuj sekretów")
> jedzie tutaj, bo agenta, który zapomniał wkleić snippet, i tak trzeba ochronić przed
> zaśmieceniem/zatruciem kolejki.
>
> Treść poniżej to **dosłowne** stringi `description` używane w kodzie
> (`apps/server/src/mcp/tool-contract.ts`) — źródło prawdy dla obu miejsc jest to samo (kopiowane
> ręcznie 1:1; przy zmianie jednego zaktualizuj drugie). Angielski — opisy adresowane są do
> dowolnego agenta LLM, nie tylko polskojęzycznego operatora.

---

## `search_memory`

```
Search the shared project memory (facts and documents) using hybrid full-text + semantic search.

Scope: your project's memories plus "global" memories (shared across all projects). You cannot
see other projects' memories.

Returns headers only, ranked by relevance — call get_memory(id) to fetch the full body of anything
that looks relevant. For `kind=document` results, an `excerpt` of the best-matching passage is
included alongside the header. Default kind filter is fact + document; `event` memories are
excluded from the default unless enabled for your project by an operator. Pass `kind` (`fact` |
`document` | `event`) to target one kind explicitly. `tags` filters to memories sharing at least
one of the given tags (any-of match).

If semantic search is temporarily unavailable, results silently fall back to full-text only — no
error, no signal that this happened.

If nothing relevant is found, an empty list is returned — this is not an error.
```

## `get_memory`

```
Fetch the full body of a single memory by id (as returned by search_memory or save_memory).

Enforces the same project+global scope as search_memory: an id outside your scope returns the
exact same not_found error as an id that does not exist at all. This is by design — no
information is leaked about whether an id belongs to another project's memory.

Errors: {code: "not_found", message} when the id is unknown or out of scope for your token.
```

## `save_memory` (load-bearing — pełny kontrakt)

```
Propose a new memory (a fact or a document) to add to the shared project memory.

IMPORTANT — human-gated write: this does NOT write to memory immediately. It creates a pending
proposal that a human reviewer must approve before it becomes visible to search_memory/get_memory
(to you or to any other agent). Do not expect to find it again later in the same session — this
is a fire-and-forget write, not a synchronous commit.

Choose the kind with the optional `kind` parameter: "fact" (the default — omit `kind` to save a
fact) or "document". `event` memories exist but are human-only and cannot be created here.

One atomic fact per call for facts: do not bundle multiple unrelated facts into a single
header/body — call save_memory once per fact. A document is instead a single self-contained
reference text (a decision record, spec, or convention writeup), saved whole.

- header: a short one-line title (<=200 chars; newlines are collapsed to spaces).
- body: the content in markdown (size limit ~8KB for a fact, ~256KB for a document).
- tags: up to ~10 short lowercase tags ([a-z0-9-_/], no spaces) for filtering later.
- supersedes: (optional) id of an existing fact/document in your project to correct; omit to save
  a brand-new memory.

Scope: always saved to YOUR project — never global. Promotion to global is a human action in the
dashboard.

Correcting an existing memory (`supersedes`): set the optional `supersedes` parameter to the id of
a memory you found via search_memory/get_memory to propose a CORRECTION of it, instead of adding a
loose near-duplicate. The `header` and `body` you provide are the full corrected content (required,
exactly like a normal save) and replace the target in place if approved — there is no content-free
"retire" option. The target must be one of YOUR project's `fact` or `document` memories, and its
kind must match the `kind` you pass (you cannot change a fact into a document or vice versa). You
still cannot delete memories, correct `event` memories, or correct `global` memories — those are
human-only. An unknown id, or an id outside your project's scope, returns the same `not_found`
error as get_memory (no cross-project leak). A supersede is still a human-gated, fire-and-forget
proposal, and is deliberately exempt from duplicate detection — the whole point is that a
correction may closely resemble what it replaces.

NEVER include secrets (API keys, passwords, private keys, tokens, credentials) in header or body.
Such content is rejected before it reaches storage (`secret_blocked` error) — the memory is not
saved, and there is no in-place redaction to fall back on. Rewrite it referring to the secret by
name or purpose only, never by value, and try again.

Return value: {id, status}.
- status "pending": a new proposal was created and is awaiting human review. With `supersedes`,
  `id` refers to the correction proposal (not the target memory, which keeps its own id until
  approved).
- status "duplicate_pending": an identical proposal is already pending — `id` refers to that
  existing proposal, not a new one. With `supersedes`, this means an identical correction (same
  target + same corrected content) is already pending.
- status "already_exists": an identical memory is already approved — `id` refers to that memory.
  Note: duplicate detection currently keys only on header+body, not kind — saving the same
  header+body under a different `kind` than an existing fact/document will also be classified as
  a duplicate. Not applicable to `supersedes` — corrections are exempt from duplicate detection
  (see above).

None of these statuses are errors. This is fire-and-forget — do not poll or wait for approval.
```

---

## Taksonomia błędów (referencja szybka — pełny opis w tech-stack §5)

| Warstwa | Przypadek | Sygnał |
|---|---|---|
| Tool-level (`isError: true` + `{code, message}`) | walidacja poza limitem | `validation_error` |
| | sekret wykryty przy `save_memory` | `secret_blocked` |
| | `get_memory` poza scope lub nieistniejące | `not_found` |
| | `save_memory` z `supersedes` — target nieznany lub poza scope (IDOR-safe, jak `get_memory`) | `not_found` |
| | `save_memory` z `supersedes` — target `kind=event`, `kind` korekty ≠ `kind` targetu, lub target `scope=global` | `validation_error` |
| Transport (HTTP) | zły/brak bearer | `401` |
| | rate limit (per token × narzędzie) | `429` + `Retry-After` |
| Nie-błąd (status w wyniku `save_memory`) | — | `pending` / `duplicate_pending` / `already_exists` |

`code` jest stabilne (agenci/plugin mogą się na nim opierać) — treść `message` może się zmieniać.

## Warstwy 2 i 3 (poza zakresem tego dokumentu)

- **Warstwa 2** — snippet do `CLAUDE.md`/`AGENTS.md` (proaktywność: "szukaj w pamięci na starcie
  zadania" + forma połączenia `Bearer ${VAR}`) → dochodzi razem z resztą onboardingu (Faza 8).
- **Warstwa 3** — plugin Claude Code (bundle config + skill) → v1.1, poza zakresem v1.
