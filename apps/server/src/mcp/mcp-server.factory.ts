import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ToolError, toErrorEnvelope } from '../common/errors';
import { MemoryService } from '../memory/memory.service';
import type { ProjectContext } from '../projects/projects.service';
import { GET_MEMORY_DESCRIPTION, SAVE_MEMORY_DESCRIPTION, SEARCH_MEMORY_DESCRIPTION } from './tool-contract';

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
 * `projectContext` (z `BearerGuard`) domykany w closure: narzędzia widzą scope tokena bez
 * globalnego stanu/mapy sesji.
 */
export function createMcpServer(memory: MemoryService, ctx: ProjectContext): McpServer {
  const server = new McpServer({ name: 'context-keeper', version: '0.1.0' });

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
          .enum(['fact', 'document', 'event'])
          .optional()
          .describe(
            'Optional kind filter. Default is fact + document; event is excluded from the default ' +
              'unless enabled for your project by an operator. Pass kind="event" to target it explicitly.',
          ),
      },
    },
    async ({ query, tags, kind }) =>
      runTool(async () => {
        const results = await memory.search({ query, tags, kind }, ctx);
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
        const result = await memory.get(id, ctx);
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
          .enum(['fact', 'document', 'event'])
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
              type: z.enum(['caused_by', 'follows', 'context_for']),
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
        const result = await memory.save(
          { header, body, tags, kind, eventTime: event_time, supersedes, relations },
          ctx,
        );
        return jsonResult(result);
      }),
  );

  return server;
}
