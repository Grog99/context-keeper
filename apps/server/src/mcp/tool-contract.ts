/**
 * Warstwa 1 kontraktu z agentem (§14 tech-stack) — opisy narzędzi MCP niesione przez `tools/list`.
 * Źródło/baseline wersjonowane w `context/mcp-tool-contract.md` — te stringi są z nim
 * zsynchronizowane 1:1 (ręcznie; przy zmianie jednego zaktualizuj drugie).
 *
 * WYJĄTEK (stan na 2026-10-06): akapit błędów scope'u projektu v1.5 (`PROJECT_SCOPE_ERRORS`), opisy
 * narzędzi konta (`LIST_PROJECTS_DESCRIPTION`, `CREATE_PROJECT_DESCRIPTION`) oraz zaktualizowane
 * brzmienie o HTTP 429 (limit per token, per narzędzie, per projekt) NIE są jeszcze w
 * `context/mcp-tool-contract.md`. Synchronizacja kanonu to osobny krok po zakresach A/B/C
 * (ticket `.tickets/multi-repo-contract.md`, "Poza zakresem"). Także wyszukiwanie między projektami —
 * parametr `all_projects` i pole `project` w `SEARCH_MEMORY_DESCRIPTION`, odczyt pamięci dowolnego
 * projektu tokenem konta w `GET_MEMORY_DESCRIPTION` (ticket `.tickets/cross-project-search.md`, G11) —
 * czeka na tę samą zbiorczą synchronizację kanonu po v1.5 (`context/mcp-tool-contract.md`, tech-stack
 * §5/§6/§10, prd FR-M1/FR-M2/NFR-1).
 */

/**
 * Wspólny akapit o wyborze projektu i kodach błędów scope'u (roadmap v1.5, ticket #12/#21) —
 * doklejany do opisów WSZYSTKICH narzędzi pamięci. Wzmianki o list_projects / create_project to
 * statyczny tekst (opis jest taki sam dla każdego tokena) — same narzędzia rejestruje fabryka wyłącznie
 * dla tokenu konta, więc token projektowy nie dostaje ich na `tools/list`.
 */
const PROJECT_SCOPE_ERRORS = `Project selection: your project is determined by your token. A project token is bound to one project. An account token works in any project of the instance — the project is then chosen by the \`X-Context-Keeper-Project: <slug>\` HTTP header configured in the repo's .mcp.json (a lowercase slug such as "my-project").

Project errors (returned as a tool error {code, message, details?} — the MCP connection itself stays healthy):
- project_required: you use an account token but no project header was sent. \`details.projects\` lists every project as {slug, name}; pick the right slug and add the header to .mcp.json. With an account token, call list_projects for ready-made .mcp.json blocks.
- project_not_found: the header slug matches no project. \`details.projects\` lists the known projects; fix the header value (the usual cause is a typo). If the project does not exist yet, propose it with create_project({name, slug}) (account tokens only; a human approves it).
- project_pending: the slug belongs to a project that is still awaiting human approval — try again after a human approves it. Do not call create_project again for it.
- project_forbidden: your token is bound to a different project than the header names. Remove the header or use a token valid for that project; no list is returned.
These are configuration problems, not transient failures: do not retry them in a loop — fix the configuration or tell the user.`;

export const SEARCH_MEMORY_DESCRIPTION = `Search the shared project memory (facts and documents) using hybrid full-text + semantic search.

Scope: by default, your current project's memories plus "global" memories (shared across all projects); other projects' memories are not searched.

Searching all projects (account tokens only): pass \`all_projects: true\` — exactly this snake_case key; a misspelled key such as \`allProjects\` is silently ignored and you get the default search — to search the memories of EVERY project on this instance plus global, in one ranked list with no preference for your current project. Each result then also carries \`project\`: the slug of the project it comes from, or null for a global memory (in the default mode results have no \`project\` field). Use it when the answer may live in another repo ("how did we solve this elsewhere?"). A memory from another project records that project's decisions and conventions, which may not apply to yours — check before acting on it. With an account token, get_memory(id) reads ids from any project. With a project token, \`all_projects: true\` returns validation_error — a project token is bound to its one project; omit the parameter.

Returns headers only, ranked by relevance — call get_memory(id) to fetch the full body of anything that looks relevant. For \`kind=document\` results, an \`excerpt\` of the best-matching passage is included alongside the header (omitted when semantic search is temporarily unavailable — see below — since there is no query vector to pick a passage). Default kind filter is fact + document; \`event\` memories are excluded from the default unless enabled for your project by an operator (with \`all_projects: true\` too, your current project's setting decides). Pass \`kind\` (\`fact\` | \`document\` | \`event\`) to target one kind explicitly. \`tags\` filters to memories sharing at least one of the given tags (any-of match).

If semantic search is temporarily unavailable, results silently fall back to full-text only — no error, no signal that this happened.

If nothing relevant is found, an empty list is returned — this is not an error.

${PROJECT_SCOPE_ERRORS}`;

export const GET_MEMORY_DESCRIPTION = `Fetch the full body of a single memory by id (as returned by search_memory or save_memory).

Scope depends on your token. With a project token: the same project+global scope as search_memory — an id outside your scope returns the exact same not_found error as an id that does not exist at all. This is by design — no information is leaked about whether an id belongs to another project's memory. With an account token: a memory of any project on this instance can be read (for example an id returned by search_memory with \`all_projects: true\`); save_memory's \`supersedes\` and \`relations\` still accept only ids from the project in your X-Context-Keeper-Project header.

Errors: {code: "not_found", message} when the id is unknown or out of scope for your token.

${PROJECT_SCOPE_ERRORS}`;

export const SAVE_MEMORY_DESCRIPTION = `Propose a new memory (a fact, a document, or an event) to add to the shared project memory.

IMPORTANT — human-gated write: this does NOT write to memory immediately. It creates a pending proposal that a human reviewer must approve before it becomes visible to search_memory/get_memory (to you or to any other agent). Do not expect to find it again later in the same session — this is a fire-and-forget write, not a synchronous commit.

Choose the kind with the optional \`kind\` parameter: "fact" (the default — omit \`kind\` to save a fact), "document", or "event". An \`event\` is something that happened at a point in time — a deploy, an incident, a decision made in a meeting — and REQUIRES the \`event_time\` parameter: there is no implicit "now", and a missing or unparseable \`event_time\` returns \`validation_error\`. Backdating is unrestricted and future timestamps are accepted.

One atomic fact per call for facts: do not bundle multiple unrelated facts into a single header/body — call save_memory once per fact. A document is instead a single self-contained reference text (a decision record, spec, or convention writeup), saved whole.

- header: a short one-line title (<=200 chars; newlines are collapsed to spaces).
- body: the content in markdown (size limit ~8KB for a fact, ~8KB for an event, ~256KB for a document).
- event_time: REQUIRED when \`kind\` is "event", rejected for fact/document. ISO 8601 timestamp of WHEN the event happened (e.g. "2026-07-28T14:30:00Z") — not when you are saving it. Any point in the past or the future is accepted.
- tags: up to ~10 short lowercase tags ([a-z0-9-_/], no spaces) for filtering later.
- supersedes: (optional) id of an existing fact/document in your project to correct; omit to save a brand-new memory. Not available for events.
- relations: (optional) up to 16 typed, directed edges FROM this memory TO existing memories in your project; see "Relating memories" below.

Scope: always saved to YOUR project — never global. Promotion to global is a human action in the dashboard. A note on finding events again: \`event\` memories are excluded from the DEFAULT kind filter of search_memory unless an operator enabled them for your project, so pass \`kind: "event"\` explicitly when you look for one.

Correcting an existing memory (\`supersedes\`): set the optional \`supersedes\` parameter to the id of a memory you found via search_memory/get_memory to propose a CORRECTION of it, instead of adding a loose near-duplicate. The \`header\` and \`body\` you provide are the full corrected content (required, exactly like a normal save) and replace the target in place if approved — there is no content-free "retire" option. The target must be one of YOUR project's \`fact\` or \`document\` memories — never an \`event\`, even though you can now create events — and its kind must match the \`kind\` you pass (you cannot change a fact into a document or vice versa). You still cannot delete memories, correct \`event\` memories, or correct \`global\` memories — those are human-only. An unknown id, or an id outside your project's scope, returns the same \`not_found\` error as get_memory (no cross-project leak). A supersede is still a human-gated proposal, and is deliberately exempt from duplicate detection — the whole point is that a correction may closely resemble what it replaces.

Relating memories (\`relations\`): set the optional \`relations\` parameter to an array of \`{type, targetId}\` (up to 16) to attach typed, directed edges FROM this memory (the one being saved, or the corrected version when using \`supersedes\`) TO existing memories you found via search_memory/get_memory. \`type\` is one of "caused_by" | "follows" | "context_for" — a fixed, closed vocabulary, not a free-form label. Each \`targetId\` must be an existing memory in YOUR project; unlike \`supersedes\`, the target CAN be a \`kind=event\` memory (relations are orthogonal to event_time — e.g. \`context_for\` to link a fact to the event it explains), but still cannot be \`global\`, in another project, or the memory being saved itself (a self-loop). Relations ride the SAME human-gated proposal as the rest of this call — edges are not created until a human approves — using the identical taxonomy as \`supersedes\`: an unknown or out-of-scope \`targetId\` returns the same \`not_found\` error as get_memory (no cross-project leak), and a \`global\` target or a self-loop returns \`validation_error\`. Duplicate \`{type, targetId}\` pairs within one call are silently merged. Relating two arbitrary EXISTING memories to each other (neither one currently being saved/corrected) is out of scope here — that is a human action in the dashboard. If this call is instead classified as "duplicate_pending" or "already_exists" (see Return value below), \`relations\` is silently dropped along with the rest of the redundant proposal — retry with \`supersedes\` if you need to attach relations to an already-existing memory.

NEVER include secrets (API keys, passwords, private keys, tokens, credentials) in header or body. Such content is rejected before it reaches storage (\`secret_blocked\` error) — the memory is not saved, and there is no in-place redaction to fall back on. Rewrite it referring to the secret by name or purpose only, never by value, and try again.

Return value: {id, status}.
- status "pending": a new proposal was created and is awaiting human review. With \`supersedes\`, \`id\` refers to the correction proposal (not the target memory, which keeps its own id until approved).
- status "duplicate_pending": an identical proposal is already pending — \`id\` refers to that existing proposal, not a new one. With \`supersedes\`, this means an identical correction (same target + same corrected content) is already pending.
- status "already_exists": an identical memory is already approved — \`id\` refers to that memory. Duplicate detection keys on header+body+kind — plus \`event_time\` for events, so the same event text recorded at two different times is two memories, not a duplicate. Not applicable to \`supersedes\` — corrections are exempt from duplicate detection (see above).

None of these statuses are errors. This is fire-and-forget — do not poll or wait for approval.

If a call is rejected with HTTP 429 (rate limited per token and per tool — with an account token, separately for each project), back off and retry after the indicated delay — do not retry in a tight loop.

${PROJECT_SCOPE_ERRORS}`;

/**
 * Narzędzia konta (roadmap v1.5, scope B) — rejestrowane WYŁĄCZNIE dla tokenu konta (zawsze, z
 * nagłówkiem i bez; tokenowi projektowemu nie ma ich na `tools/list`, a bezpośrednie wywołanie daje
 * "Tool not found" z SDK). Nigdy nie zwracają tokena: `Authorization` w blokach to placeholder
 * `${CONTEXT_KEEPER_TOKEN}`.
 */
export const LIST_PROJECTS_DESCRIPTION = `List the projects on this Context Keeper instance together with ready-to-use configuration blocks. Available to account tokens only.

Returns {projects, agentsMd, claudeMd, mcpUrlConfigured, hint}:
- projects: [{slug, name, mcpJson}] sorted by slug. \`mcpJson\` is the complete .mcp.json for that project — it carries the \`X-Context-Keeper-Project: <slug>\` header. Copy the entry that matches the current repo into the repo's .mcp.json and commit it.
- agentsMd / claudeMd: the shared blocks to add to the repo's AGENTS.md and CLAUDE.md (identical for every project, so they appear once).
- mcpUrlConfigured: false means the server does not know its public URL and mcpJson uses a placeholder URL — take the real one from your client's global MCP configuration.

The token is NEVER returned: mcpJson refers to it only as the \`\${CONTEXT_KEEPER_TOKEN}\` environment variable of the user's machine. Do not write a token into any file.

This is a read-only call and is not human-gated. If the repo's project is not listed, propose it with create_project.`;

export const CREATE_PROJECT_DESCRIPTION = `Propose a new project for this Context Keeper instance. Available to account tokens only.

IMPORTANT — human-gated: this does NOT create the project immediately. It creates a pending proposal that a human must approve in the dashboard queue; rejection frees the slug again. This is fire-and-forget — do not poll or wait for approval.

Parameters:
- name: human-readable project name (1-200 chars, single line).
- slug: identifier that becomes the \`X-Context-Keeper-Project\` header value. Whitespace is trimmed and the value is lowercased; the result must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be 2-48 characters. Suggest the repository or directory name (for example "my-service").

Return value: {status: "pending", proposalId, project: {slug, name}, mcpJson, agentsMd, claudeMd, mcpUrlConfigured, next}. Commit mcpJson as the repo's .mcp.json right away (and add agentsMd / claudeMd to AGENTS.md / CLAUDE.md): once a human approves, the same configuration starts working with no further change. Until then memory tools with this header return project_pending — a configuration state, not a failure; do not retry in a loop and do not call create_project again for the same slug. The token is never returned: mcpJson uses the \`\${CONTEXT_KEEPER_TOKEN}\` placeholder.

Errors: validation_error when the slug is malformed, when a project with that slug already exists (use list_projects and its mcpJson instead), or when a proposal for that slug is already pending. secret_blocked when the name looks like a credential.

If a call is rejected with HTTP 429, create_project has its own low per-token rate limit — back off and retry after the indicated delay.`;
