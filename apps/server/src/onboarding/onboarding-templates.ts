import { PROJECT_HEADER_NAME } from '../projects/project-scope';
import { PROJECT_SLUG_MAX, PROJECT_SLUG_MIN } from '../projects/slug';

/**
 * Szablony onboardingu (roadmap v1.5, ticket #19) — JEDNO źródło tekstów dla agenta (narzędzia MCP
 * `list_projects`/`create_project`) i dla człowieka (endpoint `/api` dla ekranu "Onboarding", zakres C).
 * Moduł CZYSTY (bez Nest/DB) — testowalny jednostkowo (`onboarding-templates.spec.ts`).
 *
 * Teksty są agent-facing (angielski, jak `mcp/tool-contract.ts`). NIGDY nie zawierają tokena —
 * `Authorization` to literalny placeholder `${CONTEXT_KEEPER_TOKEN}` (zmienna środowiskowa użytkownika,
 * ta sama dla tokenu konta i projektowego).
 *
 * Moduł niesie też kroki zapisu konfiguracji repo (`ONBOARDING_SETUP_STEPS`) i tekst promptu MCP
 * `onboard` (`ONBOARD_PROMPT_TEXT`) — kroki mają JEDNO źródło wspólne dla `hint`, `next` i promptu.
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

/** Nagłówek bloku `AGENTS.md` — także znacznik idempotencji w krokach zapisu (`ONBOARDING_SETUP_STEPS`, G5). */
export const AGENTS_MD_HEADING = 'Project memory — Context Keeper';

/** Snippet do `AGENTS.md` dowolnego repo podpiętego pod tę instancję (Codex/Cursor czytają go
 * bezpośrednio, Claude Code przez `@AGENTS.md` w `CLAUDE.md` — `CLAUDE_MD_BLOCK`). Niezależny od
 * projektu (slug siedzi w `.mcp.json`), więc zwracany RAZ, nie per projekt. Uogólniony z `AGENTS.md`
 * tego repo; akapit "Project binding" opisuje model v1.5 (nagłówek + token z env). */
export const AGENTS_MD_BLOCK = `## ${AGENTS_MD_HEADING} (MCP)

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

/**
 * Kroki zapisu konfiguracji repo (ticket mcp-onboard-prompt, G1/G5/G5a/G6). Agent-facing (angielski),
 * BEZ tokena. Cała polityka zapisu mieszka TUTAJ — dociera do każdego klienta przez `hint`
 * (`list_projects`) i `next` (`create_project`), a prompt `onboard` tylko ją powtarza (ticket #17:
 * nic load-bearing wyłącznie w promptcie).
 */
const SETUP_STEPS: readonly string[] = [
  'Plan every file change first and show the user a diff of each file; write nothing until they confirm.',
  `.mcp.json: if the repo has none, create it from mcpJson. If it exists, merge — set only mcpServers["${MCP_SERVER_NAME}"] to the entry from mcpJson and keep every other server and top-level key exactly as it is; never replace the whole file.`,
  `If .mcp.json already has a "${MCP_SERVER_NAME}" entry without the ${PROJECT_HEADER_NAME} header (a project-token setup), do not switch it silently: explain that with the header this repo needs an account token in CONTEXT_KEEPER_TOKEN — which breaks other repos that still rely on a project token in that same variable — and ask the user before replacing the entry. If the entry already has the same ${PROJECT_HEADER_NAME} value, leave it as is.`,
  `AGENTS.md: append agentsMd (create the file if it is missing) only when the file has no "${AGENTS_MD_HEADING}" heading yet; otherwise leave it unchanged.`,
  'CLAUDE.md: if it is missing, create it from claudeMd; if it exists, add the single line @AGENTS.md only when no such line is present — never a second heading.',
  'Check that the CONTEXT_KEEPER_TOKEN environment variable is set WITHOUT printing its value (e.g. `[ -n "$CONTEXT_KEEPER_TOKEN" ] && echo set || echo missing`, or in PowerShell `if ($env:CONTEXT_KEEPER_TOKEN) { "set" } else { "missing" }`). If it is missing, tell the user to set it to their account token themselves (setx on Windows, export in the shell profile) — never ask for the token in the chat and never write a token into any file.',
  `Finish by telling the user plainly: in Claude Code the repo's "${MCP_SERVER_NAME}" entry fully replaces a user-scope "${MCP_SERVER_NAME}" entry of the same name (fields are not merged), so the token now comes only from CONTEXT_KEEPER_TOKEN — without it the server answers 401; they must restart the MCP client (and the terminal, if the variable was just set) and approve the "${MCP_SERVER_NAME}" server when the client asks. The changed files are meant to be committed.`,
];

/** Kroki zapisu konfiguracji repo jako numerowana lista markdown — JEDNO źródło dla `hint` (`list_projects`), `next` (`create_project`) i promptu `onboard`. */
export const ONBOARDING_SETUP_STEPS = SETUP_STEPS.map((s, i) => `${i + 1}. ${s}`).join('\n');

/** Prompt MCP `onboard` — rejestrowany tylko dla tokenu konta (`mcp-server.factory.ts`). */
export const ONBOARD_PROMPT_NAME = 'onboard';
export const ONBOARD_PROMPT_TITLE = 'Connect this repo to Context Keeper';
export const ONBOARD_PROMPT_DESCRIPTION =
  'Connect the current repository to this Context Keeper instance: find or propose its project with ' +
  'list_projects / create_project, then merge .mcp.json and add the AGENTS.md / CLAUDE.md blocks safely (diff first).';

/**
 * Statyczny tekst promptu `onboard` (G3: `prompts/get` nie dotyka bazy ani tokena). UWAGA (ticket #17):
 * polityka zapisu należy do `SETUP_STEPS`, NIGDY wyłącznie do tego promptu — agent, który promptu nie
 * wywoła, dostaje te same kroki przez `hint`/`next`. Tu zostaje tylko orkiestracja narzędzi.
 */
export const ONBOARD_PROMPT_TEXT = [
  `Connect this repository to Context Keeper — the MCP server "${MCP_SERVER_NAME}" that provides shared, human-gated project memory. Follow the steps in order and keep the user in the loop.`,
  '',
  '## 1. Pick the project',
  '- Call list_projects. It returns the existing projects (each with a ready-made mcpJson), the agentsMd / claudeMd blocks and a hint.',
  `- Propose a slug derived from the repository or directory name (lowercase a-z, digits, single hyphens between segments, ${PROJECT_SLUG_MIN}-${PROJECT_SLUG_MAX} characters) and confirm it with the user before going on.`,
  '- If a listed project matches, use its mcpJson. If none does, ask the user for a human-readable project name and call create_project({name, slug}). It only PROPOSES the project: a human approves it in the dashboard queue, and until then memory tools return project_pending. Do not call create_project again for the same slug and do not poll.',
  '',
  '## 2. Write the configuration',
  'Use the mcpJson, agentsMd and claudeMd exactly as returned by list_projects or create_project — do not hand-write them, and never put a token into any file or into the chat.',
  '',
  ONBOARDING_SETUP_STEPS,
  '',
  '## 3. Edge cases',
  '- mcpUrlConfigured: false means mcpJson contains a placeholder URL — ask the user for the real MCP URL (from their global MCP configuration) and use it before writing.',
  '- A tool error with code project_required / project_not_found / project_pending is a configuration state, not a failure — follow its message instead of retrying.',
].join('\n');
