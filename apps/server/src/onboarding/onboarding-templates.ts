import { PROJECT_HEADER_NAME } from '../projects/project-scope';

/**
 * Szablony onboardingu (roadmap v1.5, ticket #19) — JEDNO źródło tekstów dla agenta (narzędzia MCP
 * `list_projects`/`create_project`) i dla człowieka (endpoint `/api` dla ekranu "Onboarding", zakres C).
 * Moduł CZYSTY (bez Nest/DB) — testowalny jednostkowo (`onboarding-templates.spec.ts`).
 *
 * Teksty są agent-facing (angielski, jak `mcp/tool-contract.ts`). NIGDY nie zawierają tokena —
 * `Authorization` to literalny placeholder `${CONTEXT_KEEPER_TOKEN}` (zmienna środowiskowa użytkownika,
 * ta sama dla tokenu konta i projektowego).
 */

/** Nazwa serwera MCP w `.mcp.json` (klucz w `mcpServers`). */
export const MCP_SERVER_NAME = 'context-keeper';
/** Literalny placeholder tokena — `${…}` rozwija klient MCP z env użytkownika, nie ten serwer. */
export const TOKEN_ENV_PLACEHOLDER = '${CONTEXT_KEEPER_TOKEN}';
/** URL MCP, gdy operator nie skonfigurował `PUBLIC_MCP_URL`/`ACME_DOMAIN`. */
export const MCP_URL_PLACEHOLDER = 'https://<your-mcp-host>/mcp';

/** Wejście szablonów per projekt (wyjście `listProjectSummaries`). */
export interface OnboardingProject {
  slug: string;
  name: string;
}

/**
 * Blok `.mcp.json` repo. `slug` podany → wariant z nagłówkiem `X-Context-Keeper-Project` (token konta
 * z globalnej konfiguracji + projekt z repo); bez `slug` → wariant dla tokenu projektowego (bez
 * nagłówka, zakres C). `JSON.stringify` nad zwykłym stringiem (nie template literal) celowo —
 * `Authorization` MUSI wylądować w schowku jako literalny placeholder, nie zinterpolowany string.
 */
export function renderMcpJson(mcpUrl: string, slug?: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${TOKEN_ENV_PLACEHOLDER}`,
            ...(slug !== undefined ? { [PROJECT_HEADER_NAME]: slug } : {}),
          },
        },
      },
    },
    null,
    2,
  );
}

/** Snippet do `AGENTS.md` dowolnego repo podpiętego pod tę instancję (Codex/Cursor czytają go
 * bezpośrednio, Claude Code przez `@AGENTS.md` w `CLAUDE.md` — `CLAUDE_MD_BLOCK`). Niezależny od
 * projektu (slug siedzi w `.mcp.json`), więc zwracany RAZ, nie per projekt. Uogólniony z `AGENTS.md`
 * tego repo; akapit "Project binding" opisuje model v1.5 (nagłówek + token z env). */
export const AGENTS_MD_BLOCK = `## Project memory — Context Keeper (MCP)

This project uses a Context Keeper instance as shared, persistent, human-gated
project memory, exposed as an MCP server named \`context-keeper\`. Tools:
\`search_memory\`, \`get_memory\`, \`save_memory\`. Each tool's own MCP description
carries the full contract (writes are human-gated, secrets are rejected, return
statuses) — this snippet only covers when to reach for them and what to store.

Project binding: this repo's \`.mcp.json\` selects the Context Keeper project with the
\`${PROJECT_HEADER_NAME}\` header; the token comes from the \`CONTEXT_KEEPER_TOKEN\`
environment variable and is never committed. If a memory tool returns \`project_required\`,
\`project_not_found\` or \`project_pending\`, follow the error message instead of retrying —
with an account token, \`list_projects\` and \`create_project\` fix the setup.

Work proactively:
- At the START of a task, call \`search_memory\` to pull relevant project context
  (decisions, conventions, environment specifics) before you start guessing.
- When a non-obvious decision, fact, or convention comes up, propose it with
  \`save_memory\` yourself — don't wait to be asked.

What to save, and as which kind:
- \`fact\` (the default) — one atomic, self-contained fact: a decision, a team
  convention, a "why", a deployment specific.
- \`document\` — a longer, self-contained reference saved whole (a decision record,
  a spec, a convention writeup). Pass \`kind: "document"\`.
- \`event\` — something that happened at a point in time (a deploy, an incident, a
  decision made in a meeting). Pass \`kind: "event"\` AND \`event_time\` (ISO 8601,
  e.g. \`2026-07-28T14:30:00Z\`) — \`event_time\` is required, there is no implicit
  "now", and it is when the event HAPPENED, not when you save it. Backdating is
  unrestricted. Correcting an event afterwards (including its \`event_time\`) stays
  human-only.
- To fix something already in memory, find it via \`search_memory\` and re-save it
  with \`supersedes: <id>\` — your new header+body replace it in place — rather than
  adding a near-duplicate.
- To link this memory to one you already found, pass \`relations: [{type, targetId}]\`
  (\`caused_by\` | \`follows\` | \`context_for\`, up to 16) — boosts related results in
  later searches.

Memory hygiene:
- Save only what you can't derive from the repo — decisions, team conventions,
  the "why", deployment specifics. Don't store what's already in the README, docs,
  or code.`;

/** Notatka dla Claude Code (nie czyta `AGENTS.md` automatycznie, w odróżnieniu od Codex/Cursor). */
export const CLAUDE_MD_BLOCK = '# CLAUDE.md\n@AGENTS.md';
