import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ToolError, toErrorEnvelope } from '../common/errors';
import { memoryKind, relationType } from '../db/schema/enums';
import { MemoryService } from '../memory/memory.service';
import type { McpAuthContext } from '../projects/project-scope';
import type { OnboardingService } from '../onboarding/onboarding.service';
import {
  ONBOARD_PROMPT_DESCRIPTION,
  ONBOARD_PROMPT_NAME,
  ONBOARD_PROMPT_TEXT,
  ONBOARD_PROMPT_TITLE,
} from '../onboarding/onboarding-templates';
import type { ProjectProposalService } from '../onboarding/project-proposal.service';
import type { ProjectSlugService } from '../projects/project-slug.service';
import type { ProjectContext } from '../projects/projects.service';
import { getReadScope, searchReadScope } from './read-scope-policy';
import { buildScopeError } from './scope-errors';
import {
  CREATE_PROJECT_DESCRIPTION,
  GET_MEMORY_DESCRIPTION,
  LIST_PROJECTS_DESCRIPTION,
  SAVE_MEMORY_DESCRIPTION,
  SEARCH_MEMORY_DESCRIPTION,
} from './tool-contract';

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(err: ToolError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(toErrorEnvelope(err)) }] };
}

/**
 * Łapie `ToolError` (§5 tech-stack, FR-M7) i mapuje na kopertę `{code, message}` + `isError: true`.
 * Błędy NIEspodziewane (bug, DB down) lecą dalej — SDK zamieni je na wewnętrzny błąd JSON-RPC,
 * nie maskujemy ich jako tool-level (to nie jest w taksonomii §5).
 */
async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError) return errorResult(err);
    throw err;
  }
}

/**
 * Buduje nowy `McpServer` per-request (transport bezstanowy — §5 tech-stack, decyzja 1).
 * Kontekst auth (`McpAuthContext` z `BearerGuard`) domykany w closure: narzędzia widzą scope tokena
 * i stan rozwiązania projektu bez globalnego stanu/mapy sesji. Narzędzia pamięci wołają
 * `requireProject()` — dla projektu nierozwiązanego rzuca `ToolError` (→ `isError` + koperta
 * `{code, message, details?}`), nie zostawiając żadnych skutków ubocznych (audyt, `search_events`).
 *
 * Zestaw narzędzi zależy WYŁĄCZNIE od typu tokena (`auth.tokenScope`), nigdy od nagłówka ani stanu bazy
 * (ticket #13): tokenowi konta dochodzą `list_projects`/`create_project` (z nagłówkiem i bez), tokenowi
 * projektowemu nie — `tools/list` zostaje wolne od zapytań do bazy. Prompt `onboard` idzie tą samą regułą
 * (tylko `tokenScope`): tokenowi konta dochodzi capability `prompts`, projektowemu nie.
 *
 * Zakres odczytu (`ReadScope`, roadmap v1.5) jest rozstrzygany TU z typu tokena (`read-scope-policy.ts`) —
 * `MemoryService` nie zna typów tokenów.
 */
export function createMcpServer(
  deps: {
    memory: MemoryService;
    scope: Pick<ProjectSlugService, 'listProjectSummaries'>;
    onboarding: Pick<OnboardingService, 'listProjects'>;
    projectProposals: Pick<ProjectProposalService, 'proposeProject'>;
  },
  auth: McpAuthContext,
): McpServer {
  const { memory } = deps;
  const server = new McpServer({ name: 'context-keeper', version: '0.1.0' });

  async function requireProject(): Promise<ProjectContext> {
    if (auth.project.status === 'resolved') return auth.project.context;
    throw await buildScopeError(auth.project, deps.scope);
  }

  // Narzędzia konta — BEZ `requireProject()`: działają także gdy projekt nierozwiązany (to ich zadanie).
  if (auth.tokenScope === 'account') {
    server.registerTool(
      'list_projects',
      { description: LIST_PROJECTS_DESCRIPTION, inputSchema: {} },
      async () => runTool(async () => jsonResult(await deps.onboarding.listProjects())),
    );

    server.registerTool(
      'create_project',
      {
        description: CREATE_PROJECT_DESCRIPTION,
        // Format slugu NIE jest sprawdzany tu zodem (SDK zamieniłby to w surowy tekst `isError`, nie
        // kopertę `{code, message}`) — robi to `ProjectProposalService` → `validation_error`.
        inputSchema: {
          name: z.string().min(1).max(200).describe('Human-readable project name.'),
          slug: z
            .string()
            .min(1)
            .max(64)
            .describe(
              'Project slug — becomes the X-Context-Keeper-Project header value. Lowercase a-z, digits, ' +
                'single hyphens, 2-48 chars; trimmed and lowercased.',
            ),
        },
      },
      async ({ name, slug }) =>
        runTool(async () =>
          jsonResult(
            await deps.projectProposals.proposeProject(
              { name, slug },
              { tokenId: auth.tokenId, tokenLabel: auth.tokenLabel },
            ),
          ),
        ),
    );

    // Prompt `onboard` (ticket mcp-onboard-prompt G2/G3): statyczny tekst, callback nie dotyka `deps` ani
    // bazy; pierwsza rejestracja ogłasza capability `prompts` — token projektowy jej nie dostaje.
    server.registerPrompt(
      ONBOARD_PROMPT_NAME,
      { title: ONBOARD_PROMPT_TITLE, description: ONBOARD_PROMPT_DESCRIPTION },
      () => ({ messages: [{ role: 'user', content: { type: 'text', text: ONBOARD_PROMPT_TEXT } }] }),
    );
  }

  server.registerTool(
    'search_memory',
    {
      description: SEARCH_MEMORY_DESCRIPTION,
      inputSchema: {
        query: z.string().min(1).describe('Full-text search query (natural language or keywords).'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Optional tag filter — matches memories sharing at least one tag.'),
        kind: z
          .enum(memoryKind.enumValues)
          .optional()
          .describe(
            'Optional kind filter. Default is fact + document; event is excluded from the default ' +
              'unless enabled for your project by an operator. Pass kind="event" to target it explicitly.',
          ),
        // Zawsze w schemacie (oba typy tokena, G3): token projektowy z `true` dostaje jawny
        // `validation_error` zamiast cichego strip-u nieznanego klucza przez SDK.
        all_projects: z
          .boolean()
          .optional()
          .describe(
            'Optional, default false. Account tokens only. true = search every project on this instance plus ' +
              'global memories, not just your current project; each result then carries `project` (source ' +
              'project slug, or null for global). With a project token, true returns validation_error.',
          ),
      },
    },
    async ({ query, tags, kind, all_projects }) =>
      runTool(async () => {
        // `requireProject()` PIERWSZY (G1): token konta bez nagłówka + cross -> `project_required`.
        const ctx = await requireProject();
        const readScope = searchReadScope(auth.tokenScope, all_projects === true);
        const results = await memory.search({ query, tags, kind }, ctx, readScope);
        return jsonResult(results);
      }),
  );

  server.registerTool(
    'get_memory',
    {
      description: GET_MEMORY_DESCRIPTION,
      inputSchema: {
        id: z.string().min(1).describe('Memory id, as returned by search_memory or save_memory.'),
      },
    },
    async ({ id }) =>
      runTool(async () => {
        const ctx = await requireProject();
        const result = await memory.get(id, ctx, getReadScope(auth.tokenScope));
        return jsonResult(result);
      }),
  );

  server.registerTool(
    'save_memory',
    {
      description: SAVE_MEMORY_DESCRIPTION,
      inputSchema: {
        header: z.string().min(1).describe('Short one-line title (<=200 chars).'),
        body: z.string().min(1).describe('Content in markdown (fact/event <=~8KB, document <=~256KB).'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Up to ~10 short lowercase tags ([a-z0-9-_/], no spaces).'),
        kind: z
          .enum(memoryKind.enumValues)
          .optional()
          .describe(
            'Optional memory kind. Default "fact". "document" for longer canonical reference ' +
              'material. "event" for something that happened at a point in time — requires event_time.',
          ),
        event_time: z
          .string()
          .min(1)
          .optional()
          .describe(
            'REQUIRED when kind="event", rejected otherwise. ISO 8601 timestamp of WHEN the event ' +
              'happened (e.g. "2026-07-28T14:30:00Z"), not when you are saving it. Backdating is ' +
              'unrestricted and future timestamps are accepted.',
          ),
        supersedes: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Optional. Id of an existing fact/document in YOUR project to correct in place. ' +
              'When set, header+body are the full corrected replacement content (kind must match the ' +
              'target). Cannot target events, global memories, or other projects. Not available for ' +
              'kind="event" — correcting an event (including its event_time) is human-only.',
          ),
        relations: z
          .array(
            z.object({
              type: z.enum(relationType.enumValues),
              targetId: z.string().min(1),
            }),
          )
          .max(16)
          .optional()
          .describe(
            'Optional. Typed, directed edges FROM this memory (the one being saved/corrected) TO ' +
              'existing memories in YOUR project — up to 16. Each entry is {type, targetId} with ' +
              'type one of "caused_by" | "follows" | "context_for". Same human-gated proposal as the ' +
              'rest of this call: edges only appear after a human approves. targetId can be a fact, ' +
              'document, or event (events ARE allowed as relation targets, unlike supersedes) in YOUR ' +
              'project — not global, not another project, not itself. An unknown/out-of-scope ' +
              'targetId returns the same not_found error as get_memory; a global targetId returns ' +
              'validation_error.',
          ),
      },
    },
    async ({ header, body, tags, kind, event_time, supersedes, relations }) =>
      runTool(async () => {
        const ctx = await requireProject();
        const result = await memory.save(
          { header, body, tags, kind, eventTime: event_time, supersedes, relations },
          ctx,
        );
        return jsonResult(result);
      }),
  );

  return server;
}
