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
          .enum(['fact', 'document'])
          .optional()
          .describe('Optional kind filter; default is fact + document.'),
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
        body: z.string().min(1).describe('Fact content in markdown (<=~8KB).'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Up to ~10 short lowercase tags ([a-z0-9-_/], no spaces).'),
      },
    },
    async ({ header, body, tags }) =>
      runTool(async () => {
        const result = await memory.save({ header, body, tags }, ctx);
        return jsonResult(result);
      }),
  );

  return server;
}
