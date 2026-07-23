/**
 * Warstwa 1 kontraktu z agentem (§14 tech-stack) — opisy narzędzi MCP niesione przez `tools/list`.
 * Źródło/baseline wersjonowane w `context/mcp-tool-contract.md` — te stringi są z nim
 * zsynchronizowane 1:1 (ręcznie; przy zmianie jednego zaktualizuj drugie).
 */

export const SEARCH_MEMORY_DESCRIPTION = `Search the shared project memory (facts and documents) using hybrid full-text + semantic search.

Scope: your project's memories plus "global" memories (shared across all projects). You cannot see other projects' memories.

Returns headers only, ranked by relevance — call get_memory(id) to fetch the full body of anything that looks relevant. For \`kind=document\` results, an \`excerpt\` of the best-matching passage is included alongside the header. Default kind filter is fact + document; \`event\` memories are excluded from the default unless enabled for your project by an operator. Pass \`kind\` (\`fact\` | \`document\` | \`event\`) to target one kind explicitly. \`tags\` filters to memories sharing at least one of the given tags (any-of match).

If semantic search is temporarily unavailable, results silently fall back to full-text only — no error, no signal that this happened.

If nothing relevant is found, an empty list is returned — this is not an error.`;

export const GET_MEMORY_DESCRIPTION = `Fetch the full body of a single memory by id (as returned by search_memory or save_memory).

Enforces the same project+global scope as search_memory: an id outside your scope returns the exact same not_found error as an id that does not exist at all. This is by design — no information is leaked about whether an id belongs to another project's memory.

Errors: {code: "not_found", message} when the id is unknown or out of scope for your token.`;

export const SAVE_MEMORY_DESCRIPTION = `Propose a new fact to add to the shared project memory.

IMPORTANT — human-gated write: this does NOT write to memory immediately. It creates a pending proposal that a human reviewer must approve before it becomes visible to search_memory/get_memory (to you or to any other agent). Do not expect to find it again later in the same session — this is a fire-and-forget write, not a synchronous commit.

One atomic fact per call. Do not bundle multiple unrelated facts into a single header/body — call save_memory once per fact.

- header: a short one-line title (<=200 chars; newlines are collapsed to spaces).
- body: the fact content in markdown (fact size limit ~8KB).
- tags: up to ~10 short lowercase tags ([a-z0-9-_/], no spaces) for filtering later.

Scope: always saved to YOUR project — never global. Promotion to global is a human action in the dashboard.

You can only CREATE new facts in v1 (no update/delete). To correct an existing fact, save a new one that references what it supersedes in the body — a human reviewer will reconcile the two.

NEVER include secrets (API keys, passwords, private keys, tokens, credentials) in header or body. Such content is rejected before it reaches storage (\`secret_blocked\` error) — the fact is not saved, and there is no in-place redaction to fall back on. Rewrite the fact referring to the secret by name or purpose only, never by value, and try again.

Return value: {id, status}.
- status "pending": a new proposal was created and is awaiting human review.
- status "duplicate_pending": an identical proposal is already pending — \`id\` refers to that existing proposal, not a new one.
- status "already_exists": an identical fact is already approved in memory — \`id\` refers to that memory.

None of these statuses are errors. This is fire-and-forget — do not poll or wait for approval.`;
