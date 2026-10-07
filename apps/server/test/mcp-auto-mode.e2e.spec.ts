import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EMBEDDING_DIM } from '../src/db/schema';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';
import { mcpClients, textOf } from './helpers/mcp-client';
import { startMcpE2eApp, type McpE2eApp } from './helpers/mcp-app';

/**
 * MCP e2e dla auto mode (roadmap v1.6, A2): własna aplikacja (własny kontener), provider embeddingów
 * podmieniony na deterministyczne, parami ortogonalne wektory jednostkowe (każdy nowy tekst → nowa oś), więc
 * `similar_memories = []` i bezpieczniki (a)/(a′) nie zawracają zapisów. Sprawdza kontrakt widziany przez
 * agenta: status `approved`, id pamięci, brak powodu zawrócenia, brak jakiegokolwiek pola auto w MCP.
 */
describe('MCP e2e — auto mode (A2)', () => {
  let mcpApp: McpE2eApp;
  let app: NestExpressApplication;
  let baseUrl: string;
  let token: string;
  let projectId: string;
  const { withClient } = mcpClients(() => baseUrl);

  const axisByText = new Map<string, number>();
  function oneHot(text: string): number[] {
    let axis = axisByText.get(text);
    if (axis === undefined) {
      axis = axisByText.size;
      axisByText.set(text, axis);
    }
    const v = new Array<number>(EMBEDDING_DIM).fill(0);
    v[axis % EMBEDDING_DIM] = 1;
    return v;
  }

  async function save(args: Record<string, unknown>): Promise<{ id: string; status: string }> {
    return withClient(token, undefined, async (client) => {
      const res = await client.callTool({ name: 'save_memory', arguments: args });
      expect(res.isError).not.toBe(true);
      return JSON.parse(textOf(res as CallToolResult)) as { id: string; status: string };
    });
  }

  beforeAll(async () => {
    mcpApp = await startMcpE2eApp();
    app = mcpApp.app;
    baseUrl = mcpApp.baseUrl;

    const provider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
    vi.spyOn(provider, 'embed').mockImplementation(async (texts: string[]) => texts.map(oneHot));

    const projects = app.get(ProjectsService);
    const created = await projects.createProject('mcp-auto-mode');
    token = created.token;
    projectId = created.project.id;
    await projects.updateProject(projectId, { autoMode: true });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await mcpApp?.stop();
  });

  it('tools/list: żadne narzędzie nie ma pola auto w inputSchema; opis save_memory niesie approved i pending', async () => {
    await withClient(token, undefined, async (client) => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
        expect(props.filter((p) => /auto/i.test(p)), `${tool.name} nie wystawia pól auto`).toEqual([]);
      }
      const saveTool = tools.find((t) => t.name === 'save_memory')!;
      expect(saveTool.description).toMatch(/approved/);
      expect(saveTool.description).toMatch(/pending/);
    });
  });

  it('auto on: save_memory → approved z id pamięci; get_memory i search_memory widzą od razu', async () => {
    const saved = await save({ header: 'Auto e2e fakt zebra', body: 'Treść auto faktu zebra.' });
    expect(saved.status).toBe('approved');
    expect(saved.id).toMatch(/^mem_/);
    expect(Object.keys(saved).sort()).toEqual(['id', 'status']);

    await withClient(token, undefined, async (client) => {
      const got = await client.callTool({ name: 'get_memory', arguments: { id: saved.id } });
      expect((JSON.parse(textOf(got as CallToolResult)) as { body: string }).body).toBe('Treść auto faktu zebra.');
      const found = await client.callTool({ name: 'search_memory', arguments: { query: 'zebra' } });
      const results = JSON.parse(textOf(found as CallToolResult)) as Array<{ id: string }>;
      expect(results.map((r) => r.id)).toContain(saved.id);
    });
  });

  it('supersedes na auto-zaakceptowanej pamięci agenta → approved, id === cel', async () => {
    const target = await save({ header: 'Cel supersedes e2e', body: 'Pierwotna treść celu.' });
    expect(target.status).toBe('approved');
    const corrected = await save({
      header: 'Cel supersedes e2e',
      body: 'Poprawiona treść celu.',
      supersedes: target.id,
    });
    expect(corrected).toEqual({ id: target.id, status: 'approved' });
  });

  it('supersedes na pamięć człowieka → pending z id propozycji (prop_), wynik tylko {id, status}', async () => {
    const human = await app.get(MemoryService).devSeedApproved({
      header: 'Ludzka pamięć e2e',
      body: 'Napisał człowiek.',
      kind: 'fact',
      scope: 'project',
      projectId,
    });
    const res = await save({ header: 'Ludzka pamięć e2e', body: 'Agent chce poprawić.', supersedes: human.id });
    expect(res.status).toBe('pending');
    expect(res.id).toMatch(/^prop_/);
    expect(Object.keys(res).sort()).toEqual(['id', 'status']);
  });

  it('auto off → save_memory daje pending (id pamięci), bez zmian względem trybu human-gated', async () => {
    await app.get(ProjectsService).updateProject(projectId, { autoMode: false });
    const res = await save({ header: 'Bez auto e2e', body: 'Czeka w kolejce.' });
    expect(res.status).toBe('pending');
    expect(res.id).toMatch(/^mem_/);
  });
});
