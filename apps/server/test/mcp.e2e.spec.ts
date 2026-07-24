import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppModule as AppModuleType } from '../src/app.module';
import * as schema from '../src/db/schema';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';

/**
 * Cienki MCP e2e (§15 tech-stack): serwer Nest in-process (port efemeryczny) + KLIENT z oficjalnego
 * SDK po Streamable HTTP z bearerem. Zarazem smoke test łączności bearer (FR-M6).
 */
describe('MCP e2e — oficjalny SDK client po Streamable HTTP', () => {
  let container: StartedPostgreSqlContainer;
  let app: NestExpressApplication;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    // KRYTYCZNE: DATABASE_URL musi trafić do process.env PRZED zaimportowaniem app.module.ts —
    // `@Module({ imports: [ConfigModule.forRoot(), ...] })` woła `loadEnv()` w momencie EWALUACJI
    // dekoratora (czyli przy imporcie modułu), nie przy instancjonowaniu. Import na górze pliku
    // byłby zbyt wczesny (przed startem kontenera) — stąd dynamic import dopiero tutaj.
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

    const migPool = new Pool({ connectionString: container.getConnectionUri() });
    const migDb = drizzle(migPool, { schema });
    await migrate(migDb, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    await migPool.end();

    const { AppModule }: { AppModule: typeof AppModuleType } = await import('../src/app.module');
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}/mcp`;

    const projects = app.get(ProjectsService);
    const created = await projects.createProject('mcp-e2e');
    token = created.token;

    const memoryService = app.get(MemoryService);
    await memoryService.devSeedApproved({
      header: 'Postgres wymaga rozszerzenia pgvector',
      body: 'W testach uzywamy obrazu pgvector/pgvector:pg18-trixie w testcontainers.',
      kind: 'fact',
      tags: ['postgres', 'pgvector'],
      scope: 'project',
      projectId: created.project.id,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  function newClient(bearer: string): { client: Client; transport: StreamableHTTPClientTransport } {
    const client = new Client({ name: 'e2e-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    return { client, transport };
  }

  function textOf(result: CallToolResult): string {
    const item = result.content.find((c) => c.type === 'text');
    if (!item || item.type !== 'text') throw new Error('Brak content typu text w wyniku narzędzia.');
    return item.text;
  }

  it('tools/list zwraca dokładnie 3 narzędzia z load-bearing kontraktem w opisach', async () => {
    const { client, transport } = newClient(token);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['get_memory', 'save_memory', 'search_memory']);

      const save = tools.find((t) => t.name === 'save_memory')!;
      expect(save.description).toMatch(/pending/i);
      expect(save.description).toMatch(/secret/i);
      expect(save.description).toMatch(/one atomic fact/i);
      expect(save.description).toMatch(/supersede|correct/i);
    } finally {
      await transport.close();
    }
  });

  it('happy-path: save_memory -> pending, search_memory znajduje seed, get_memory zwraca body', async () => {
    const { client, transport } = newClient(token);
    await client.connect(transport);
    try {
      const saveRes = await client.callTool({
        name: 'save_memory',
        arguments: { header: 'Nowy fakt e2e', body: 'Treść nowego faktu e2e.', tags: ['e2e'] },
      });
      expect(saveRes.isError).not.toBe(true);
      const saved = JSON.parse(textOf(saveRes as CallToolResult)) as { id: string; status: string };
      expect(saved.status).toBe('pending');
      expect(saved.id).toMatch(/^mem_/);

      const searchRes = await client.callTool({
        name: 'search_memory',
        arguments: { query: 'pgvector' },
      });
      const results = JSON.parse(textOf(searchRes as CallToolResult)) as Array<{ id: string; header: string }>;
      expect(results.length).toBeGreaterThan(0);

      const getRes = await client.callTool({ name: 'get_memory', arguments: { id: results[0].id } });
      const full = JSON.parse(textOf(getRes as CallToolResult)) as { body: string };
      expect(full.body).toContain('pgvector');
    } finally {
      await transport.close();
    }
  });

  it('ścieżka błędu: get_memory z nieistniejącym id -> isError + {code: not_found}', async () => {
    const { client, transport } = newClient(token);
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: 'get_memory', arguments: { id: 'mem_doesnotexist0' } });
      expect(res.isError).toBe(true);
      const envelope = JSON.parse(textOf(res as CallToolResult)) as { code: string; message: string };
      expect(envelope.code).toBe('not_found');
    } finally {
      await transport.close();
    }
  });

  it('zły bearer -> 401 na poziomie transportu (smoke test łączności, FR-M6)', async () => {
    const { client, transport } = newClient('ck_' + 'x'.repeat(43));
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('search_memory z kind=event: event (poza domyślnym search) zwracany dopiero przy jawnym kind (roadmap v1.2)', async () => {
    const memoryService = app.get(MemoryService);
    const marker = 'mcpe2eeventkindmarker1';
    await memoryService.devSeedApproved({
      header: `Zdarzenie e2e ${marker}`,
      body: 'Tresc zdarzenia e2e.',
      kind: 'event',
      scope: 'project',
      projectId: (await app.get(ProjectsService).resolveProjectByToken(token))!.id,
    });

    const { client, transport } = newClient(token);
    await client.connect(transport);
    try {
      const defaultRes = await client.callTool({ name: 'search_memory', arguments: { query: marker } });
      const defaultResults = JSON.parse(textOf(defaultRes as CallToolResult)) as Array<{ header: string }>;
      expect(defaultResults.length).toBe(0); // toggle projektu wyłączony domyślnie -> event poza domyślnym kind

      const eventRes = await client.callTool({
        name: 'search_memory',
        arguments: { query: marker, kind: 'event' },
      });
      const eventResults = JSON.parse(textOf(eventRes as CallToolResult)) as Array<{ header: string }>;
      expect(eventResults.length).toBeGreaterThan(0);
      expect(eventResults.some((r) => r.header.includes(marker))).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('save_memory eksponuje kind (fact|document) w schemacie — event NIE jest w tools/list enumie', async () => {
    const { client, transport } = newClient(token);
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const save = tools.tools.find((t) => t.name === 'save_memory')!;
      const props = (save.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props).sort()).toEqual(['body', 'header', 'kind', 'supersedes', 'tags']);
    } finally {
      await transport.close();
    }
  });

  it('save_memory {kind: "document"} -> pending, jak fact', async () => {
    const { client, transport } = newClient(token);
    await client.connect(transport);
    try {
      const saveRes = await client.callTool({
        name: 'save_memory',
        arguments: {
          header: 'Nowy dokument e2e',
          body: 'Treść nowego dokumentu e2e.',
          kind: 'document',
          tags: ['e2e'],
        },
      });
      expect(saveRes.isError).not.toBe(true);
      const saved = JSON.parse(textOf(saveRes as CallToolResult)) as { id: string; status: string };
      expect(saved.status).toBe('pending');
      expect(saved.id).toMatch(/^mem_/);
    } finally {
      await transport.close();
    }
  });

  it('save_memory z supersedes na seeded fact -> pending (proposal type=update/origin=agent), NIE isError', async () => {
    const memoryService = app.get(MemoryService);
    const projectId = (await app.get(ProjectsService).resolveProjectByToken(token))!.id;
    const target = await memoryService.devSeedApproved({
      header: 'Fakt do supersede e2e',
      body: 'Stara tresc e2e przed korekta.',
      kind: 'fact',
      scope: 'project',
      projectId,
    });

    const { client, transport } = newClient(token);
    await client.connect(transport);
    try {
      const res = await client.callTool({
        name: 'save_memory',
        arguments: {
          header: 'Poprawiony fakt e2e',
          body: 'Nowa, poprawiona tresc e2e.',
          supersedes: target.id,
        },
      });
      expect(res.isError).not.toBe(true);
      const saved = JSON.parse(textOf(res as CallToolResult)) as { id: string; status: string };
      expect(saved.status).toBe('pending');
      expect(saved.id).toMatch(/^prop_/); // id proposala korekty, nie id targetu
    } finally {
      await transport.close();
    }
  });

  it('save_memory {kind: "event"} -> odrzucone przez SDK (event pozostaje human-only)', async () => {
    const { client, transport } = newClient(token);
    await client.connect(transport);
    try {
      // Zod enum ['fact','document'] w inputSchema (mcp-server.factory.ts) odrzuca 'event' jeszcze
      // po stronie SDK klienta, PRZED dotarciem do serwera — stąd isError zamiast rzuconego wyjątku.
      const res = await client.callTool({
        name: 'save_memory',
        arguments: { header: 'Próba zapisu eventu', body: 'To nie powinno przejść.', kind: 'event' },
      });
      expect(res.isError).toBe(true);
    } finally {
      await transport.close();
    }
  });
});
