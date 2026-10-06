import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { desc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../src/db/db.tokens';
import { auditLog, projectTokens, proposals, searchEvents } from '../src/db/schema';
import { memoryKind, relationType } from '../src/db/schema/enums';
import { MemoryAdminService } from '../src/memory/memory-admin.service';
import { MemoryService } from '../src/memory/memory.service';
import { ProjectsService } from '../src/projects/projects.service';
import { ProposalsService } from '../src/proposals/proposals.service';
import { mcpClients, textOf } from './helpers/mcp-client';
import { startMcpE2eApp, type McpE2eApp } from './helpers/mcp-app';

/**
 * Cienki MCP e2e (§15 tech-stack): serwer Nest in-process (port efemeryczny) + KLIENT z oficjalnego
 * SDK po Streamable HTTP z bearerem. Zarazem smoke test łączności bearer (FR-M6). Scenariusze tokenu
 * konta + nagłówka projektu (v1.5) są w `mcp-account-token.e2e.spec.ts`.
 */
describe('MCP e2e — oficjalny SDK client po Streamable HTTP', () => {
  let mcpApp: McpE2eApp;
  let app: NestExpressApplication;
  let baseUrl: string;
  let token: string;
  const { withClient } = mcpClients(() => baseUrl);

  beforeAll(async () => {
    mcpApp = await startMcpE2eApp();
    app = mcpApp.app;
    baseUrl = mcpApp.baseUrl;

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
    await mcpApp?.stop();
  });

  it('tools/list zwraca dokładnie 3 narzędzia z load-bearing kontraktem w opisach', async () => {
    await withClient(token, undefined, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['get_memory', 'save_memory', 'search_memory']);

      const save = tools.find((t) => t.name === 'save_memory')!;
      expect(save.description).toMatch(/pending/i);
      expect(save.description).toMatch(/secret/i);
      expect(save.description).toMatch(/one atomic fact/i);
      expect(save.description).toMatch(/supersede|correct/i);
      expect(save.description).toMatch(/event_time/); // roadmap v1.3 "kind=event przez agenta"
    });
  });

  it('happy-path: save_memory -> pending, search_memory znajduje seed, get_memory zwraca body', async () => {
    await withClient(token, undefined, async (client) => {
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
    });
  });

  it('ścieżka błędu: get_memory z nieistniejącym id -> isError + {code: not_found}', async () => {
    await withClient(token, undefined, async (client) => {
      const res = await client.callTool({ name: 'get_memory', arguments: { id: 'mem_doesnotexist0' } });
      expect(res.isError).toBe(true);
      const envelope = JSON.parse(textOf(res as CallToolResult)) as { code: string; message: string };
      expect(envelope.code).toBe('not_found');
    });
  });

  it('zły bearer -> 401 na poziomie transportu (smoke test łączności, FR-M6)', async () => {
    await expect(withClient('ck_' + 'x'.repeat(43), undefined, async () => undefined)).rejects.toThrow();
  });

  it('search_memory z kind=event: event (poza domyślnym search) zwracany dopiero przy jawnym kind (roadmap v1.2)', async () => {
    const memoryService = app.get(MemoryService);
    const marker = 'mcpe2eeventkindmarker1';
    await memoryService.devSeedApproved({
      header: `Zdarzenie e2e ${marker}`,
      body: 'Tresc zdarzenia e2e.',
      kind: 'event',
      scope: 'project',
      projectId: (await app.get(ProjectsService).resolveByToken(token))!.project.id,
    });

    await withClient(token, undefined, async (client) => {
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
    });
  });

  it('save_memory eksponuje kind (fact|document|event) + event_time w schemacie (roadmap v1.3 "kind=event przez agenta")', async () => {
    await withClient(token, undefined, async (client) => {
      const tools = await client.listTools();
      const save = tools.tools.find((t) => t.name === 'save_memory')!;
      const props = (save.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props).sort()).toEqual([
        'body',
        'event_time',
        'header',
        'kind',
        'relations',
        'supersedes',
        'tags',
      ]);
      // tech-review #3 (roadmap v1.4, Q4 resolved) — `mcp-server.factory.ts` czyta
      // `memoryKind.enumValues`/`relationType.enumValues` bezpośrednio (bez ręcznie przepisanych
      // literałów), więc `tools/list` MUSI zgadzać się bajt-w-bajt (te same wartości, ta sama
      // kolejność) z `db/schema/enums.ts` — jedno źródło prawdy.
      const kindProp = props.kind as { enum?: string[] };
      expect(kindProp.enum).toEqual(memoryKind.enumValues);

      const relationsProp = props.relations as { items?: { properties?: Record<string, unknown> } };
      const relationTypeProp = relationsProp.items?.properties?.type as { enum?: string[] };
      expect(relationTypeProp.enum).toEqual(relationType.enumValues);
    });
  });

  it('search_memory eksponuje kind z tego samego enuma co save_memory (memoryKind.enumValues, roadmap v1.4 Q4)', async () => {
    await withClient(token, undefined, async (client) => {
      const tools = await client.listTools();
      const search = tools.tools.find((t) => t.name === 'search_memory')!;
      const props = (search.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      const kindProp = props.kind as { enum?: string[] };
      expect(kindProp.enum).toEqual(memoryKind.enumValues);
    });
  });

  it('search_memory ma all_projects w inputSchema także dla tokenu projektowego (roadmap v1.5, G3)', async () => {
    await withClient(token, undefined, async (client) => {
      const tools = await client.listTools();
      const search = tools.tools.find((t) => t.name === 'search_memory')!;
      const props = (search.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props).sort()).toEqual(['all_projects', 'kind', 'query', 'tags']);
    });
  });

  it('save_memory {kind: "document"} -> pending, jak fact', async () => {
    await withClient(token, undefined, async (client) => {
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
    });
  });

  it('save_memory z supersedes na seeded fact -> pending (proposal type=update/origin=agent), NIE isError', async () => {
    const memoryService = app.get(MemoryService);
    const projectId = (await app.get(ProjectsService).resolveByToken(token))!.project.id;
    const target = await memoryService.devSeedApproved({
      header: 'Fakt do supersede e2e',
      body: 'Stara tresc e2e przed korekta.',
      kind: 'fact',
      scope: 'project',
      projectId,
    });

    await withClient(token, undefined, async (client) => {
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
    });
  });

  it('save_memory z relations -> pending, po approve materializuje krawędzie (roadmap v1.2, attach-on-save)', async () => {
    const memoryService = app.get(MemoryService);
    const projectId = (await app.get(ProjectsService).resolveByToken(token))!.project.id;
    // Cel MOŻE być kind=event (Stage-2 answer #1, świadome odstępstwo od supersedes) — target A jest
    // eventem, target B faktem, żeby ćwiczyć oba w jednym save_memory.
    const targetEvent = await memoryService.devSeedApproved({
      header: 'Zdarzenie e2e dla relacji',
      body: 'Tresc zdarzenia.',
      kind: 'event',
      scope: 'project',
      projectId,
    });
    const targetFact = await memoryService.devSeedApproved({
      header: 'Fakt e2e dla relacji',
      body: 'Tresc faktu.',
      kind: 'fact',
      scope: 'project',
      projectId,
    });

    const saved = await withClient(token, undefined, async (client) => {
      const res = await client.callTool({
        name: 'save_memory',
        arguments: {
          header: 'Nowy fakt e2e z relacjami',
          body: 'Ten fakt jest kontekstem dla zdarzenia i nastepuje po innym fakcie.',
          relations: [
            { type: 'context_for', targetId: targetEvent.id },
            { type: 'follows', targetId: targetFact.id },
          ],
        },
      });
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(textOf(res as CallToolResult)) as { id: string; status: string };
      expect(body.status).toBe('pending');
      return body;
    });

    // Przed approve — zero wierszy w memory_relations (materializacja dopiero w approve()).
    const memoryAdmin = app.get(MemoryAdminService);
    expect(await memoryAdmin.listRelations(saved.id)).toHaveLength(0);

    // `save_memory` (status="pending", create-path) zwraca ZMINTOWANY id pamięci, NIE proposala
    // (patrz test wyżej "supersedes" — to WYŁĄCZNIE update-path zwraca id proposala) — trzeba
    // odszukać proposal po `payload.memoryId`, dokładnie jak `memory.integration.spec.ts`.
    const db = app.get<Database>(DB);
    const [propRow] = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(sql`${proposals.payload} ->> 'memoryId' = ${saved.id}`);
    expect(propRow).toBeDefined();

    const proposalsService = app.get(ProposalsService);
    await proposalsService.approve(propRow.id, { actor: 'tester' });

    const relations = await memoryAdmin.listRelations(saved.id);
    expect(relations).toHaveLength(2);
    expect(relations.every((r) => r.direction === 'outgoing')).toBe(true);
    const byTarget = new Map(relations.map((r) => [r.neighbor.id, r]));
    expect(byTarget.get(targetEvent.id)?.type).toBe('context_for');
    expect(byTarget.get(targetFact.id)?.type).toBe('follows');
  });

  it('save_memory relations z nieznanym targetId -> isError + {code: not_found} (IDOR-safe, jak get_memory)', async () => {
    await withClient(token, undefined, async (client) => {
      const res = await client.callTool({
        name: 'save_memory',
        arguments: {
          header: 'Relacja do nieznanego celu',
          body: 'To nie powinno przejsc.',
          relations: [{ type: 'follows', targetId: 'mem_doesnotexist2' }],
        },
      });
      expect(res.isError).toBe(true);
      const envelope = JSON.parse(textOf(res as CallToolResult)) as { code: string };
      expect(envelope.code).toBe('not_found');
    });
  });

  it('save_memory relations z targetId=global -> isError + {code: validation_error}', async () => {
    const memoryService = app.get(MemoryService);
    const globalTarget = await memoryService.devSeedApproved({
      header: 'Globalna pamiec e2e',
      body: 'Tresc globalna.',
      kind: 'fact',
      scope: 'global',
    });

    await withClient(token, undefined, async (client) => {
      const res = await client.callTool({
        name: 'save_memory',
        arguments: {
          header: 'Relacja do global',
          body: 'To nie powinno przejsc.',
          relations: [{ type: 'follows', targetId: globalTarget.id }],
        },
      });
      expect(res.isError).toBe(true);
      const envelope = JSON.parse(textOf(res as CallToolResult)) as { code: string };
      expect(envelope.code).toBe('validation_error');
    });
  });

  it('save_memory {kind: "event", event_time} -> pending, po approve materializuje event_time (roadmap v1.3 "kind=event przez agenta")', async () => {
    const saved = await withClient(token, undefined, async (client) => {
      const res = await client.callTool({
        name: 'save_memory',
        arguments: {
          header: 'Deploy e2e przez agenta',
          body: 'Wdrozenie kind=event przez agenta, e2e.',
          kind: 'event',
          event_time: '2026-03-01T09:00:00Z',
        },
      });
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(textOf(res as CallToolResult)) as { id: string; status: string };
      expect(body.status).toBe('pending');
      expect(body.id).toMatch(/^mem_/);
      return body;
    });

    // create-path zwraca ZMINTOWANY id pamięci, nie proposala — odszukanie proposala po
    // `payload.memoryId` (wzorzec z testu "save_memory z relations" wyżej, :298-302).
    const db = app.get<Database>(DB);
    const [propRow] = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(sql`${proposals.payload} ->> 'memoryId' = ${saved.id}`);
    expect(propRow).toBeDefined();

    const proposalsService = app.get(ProposalsService);
    await proposalsService.approve(propRow.id, { actor: 'tester' });

    const memoryAdmin = app.get(MemoryAdminService);
    const detail = await memoryAdmin.getMemoryDetail(saved.id);
    expect(detail.kind).toBe('event');
    expect(detail.eventTime).toBe('2026-03-01T09:00:00.000Z');
  });

  it('save_memory {kind: "event"} bez event_time -> isError + {code: validation_error}', async () => {
    await withClient(token, undefined, async (client) => {
      const res = await client.callTool({
        name: 'save_memory',
        arguments: { header: 'Event bez daty e2e', body: 'To nie powinno przejść.', kind: 'event' },
      });
      expect(res.isError).toBe(true);
      const envelope = JSON.parse(textOf(res as CallToolResult)) as { code: string };
      expect(envelope.code).toBe('validation_error');
    });
  });

  it('save_memory {kind: "event", event_time, supersedes} -> isError + {code: validation_error} (korekta eventu human-only)', async () => {
    const memoryService = app.get(MemoryService);
    const projectId = (await app.get(ProjectsService).resolveByToken(token))!.project.id;
    const targetFact = await memoryService.devSeedApproved({
      header: 'Fakt e2e dla proby supersede eventem',
      body: 'Tresc.',
      kind: 'fact',
      scope: 'project',
      projectId,
    });

    await withClient(token, undefined, async (client) => {
      const res = await client.callTool({
        name: 'save_memory',
        arguments: {
          header: 'Proba supersede faktu przez event e2e',
          body: 'To nie powinno przejść.',
          kind: 'event',
          event_time: '2026-03-01T09:00:00Z',
          supersedes: targetFact.id,
        },
      });
      expect(res.isError).toBe(true);
      const envelope = JSON.parse(textOf(res as CallToolResult)) as { code: string };
      expect(envelope.code).toBe('validation_error');
    });
  });

  describe('roadmap v1.3 — wiele tokenów per projekt + graceful rotation', () => {
    it('dwa żywe tokeny działają jednocześnie (N agentów per projekt)', async () => {
      const projects = app.get(ProjectsService);
      const projectId = (await projects.resolveByToken(token))!.project.id;
      const created = await projects.createToken(projectId, 'agent-two-e2e');

      // Oba klienty połączone naraz (zagnieżdżone withClient) — o to w tym teście chodzi.
      await withClient(token, undefined, (clientA) =>
        withClient(created.token, undefined, async (clientB) => {
          const resA = await clientA.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
          const resB = await clientB.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
          expect(resA.isError).not.toBe(true);
          expect(resB.isError).not.toBe(true);
        }),
      );
    });

    it('graceful rotation przez wire: stary+nowy działają w grace, stary 401 identycznie do garbage po wygaśnięciu, nowy nietknięty', async () => {
      const projects = app.get(ProjectsService);
      const projectId = (await projects.resolveByToken(token))!.project.id;
      const created = await projects.createToken(projectId, 'rotation-e2e');
      const rotated = await projects.rotateToken(created.tokenRow.id);

      // Oba działają podczas grace.
      await withClient(created.token, undefined, async (oldClient) => {
        const oldRes = await oldClient.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
        expect(oldRes.isError).not.toBe(true);
      });

      await withClient(rotated.token, undefined, async (newClientInst) => {
        const newRes = await newClientInst.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
        expect(newRes.isError).not.toBe(true);
      });

      // Wymuszony upływ karencji (bez udziału żadnego nocnego joba — lazy expiry przy lookupie).
      const db = app.get<Database>(DB);
      await db
        .update(projectTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(projectTokens.id, created.tokenRow.id));

      // Stary token 401-uje na poziomie transportu (connect), IDENTYCZNIE jak nieznany/garbage token.
      await expect(withClient(created.token, undefined, async () => undefined)).rejects.toThrow();

      // Nowy token wciąż działa, nietknięty wygaśnięciem starego.
      await withClient(rotated.token, undefined, async (stillNewClient) => {
        const res = await stillNewClient.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
        expect(res.isError).not.toBe(true);
      });
    });

    it('unieważnienie (revoke) przez wire: natychmiastowy 401', async () => {
      const projects = app.get(ProjectsService);
      const projectId = (await projects.resolveByToken(token))!.project.id;
      const created = await projects.createToken(projectId, 'revoke-e2e');

      await withClient(created.token, undefined, async (liveClient) => {
        const liveRes = await liveClient.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
        expect(liveRes.isError).not.toBe(true);
      });

      await projects.revokeToken(created.tokenRow.id);

      await expect(withClient(created.token, undefined, async () => undefined)).rejects.toThrow();
    });

    it('atrybucja wyszukania: search_events.token_id wskazuje na token wywołujący', async () => {
      const projects = app.get(ProjectsService);
      const projectId = (await projects.resolveByToken(token))!.project.id;
      const created = await projects.createToken(projectId, 'search-attribution-e2e');

      await withClient(created.token, undefined, async (client) => {
        await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      });

      const db = app.get<Database>(DB);
      const [row] = await db
        .select()
        .from(searchEvents)
        .where(eq(searchEvents.projectId, projectId))
        .orderBy(desc(searchEvents.createdAt))
        .limit(1);
      expect(row.tokenId).toBe(created.tokenRow.id);
    });

    it('atrybucja zapisu: audit_log.metadata.{tokenId,tokenLabel}, actor niezmieniony (agent:<projectId>)', async () => {
      const projects = app.get(ProjectsService);
      const projectId = (await projects.resolveByToken(token))!.project.id;
      const created = await projects.createToken(projectId, 'save-attribution-e2e');

      await withClient(created.token, undefined, async (client) => {
        const res = await client.callTool({
          name: 'save_memory',
          arguments: { header: 'Fakt atrybucji e2e', body: 'Treść do sprawdzenia atrybucji.', tags: ['e2e'] },
        });
        expect(res.isError).not.toBe(true);
      });

      const db = app.get<Database>(DB);
      const [row] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'proposal_created'))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      expect(row.actor).toBe(`agent:${projectId}`); // format aktora NIEZMIENIONY (§Approach planu)
      const metadata = row.metadata as { tokenId?: string; tokenLabel?: string };
      expect(metadata.tokenId).toBe(created.tokenRow.id);
      expect(metadata.tokenLabel).toBe('save-attribution-e2e');
    });

    it('secret_blocked niesie atrybucję tokena, bez materiału sekretu', async () => {
      const projects = app.get(ProjectsService);
      const projectId = (await projects.resolveByToken(token))!.project.id;
      const created = await projects.createToken(projectId, 'secret-attribution-e2e');

      const secretMaterial = 'AKIA' + 'A'.repeat(16); // wzorzec AWS access key (secret-scanner.ts)
      await withClient(created.token, undefined, async (client) => {
        const res = await client.callTool({
          name: 'save_memory',
          arguments: { header: 'Próba zapisu sekretu e2e', body: `klucz: ${secretMaterial}` },
        });
        expect(res.isError).toBe(true);
      });

      const db = app.get<Database>(DB);
      const [row] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'secret_blocked'))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      const metadata = row.metadata as { secretType?: string; tokenId?: string; tokenLabel?: string };
      expect(metadata.tokenId).toBe(created.tokenRow.id);
      expect(metadata.tokenLabel).toBe('secret-attribution-e2e');
      expect(JSON.stringify(row.metadata)).not.toContain(secretMaterial); // bez materiału sekretu
    });

    it('rate limit jest per-token: wyczerpanie budżetu tokena A nie throttluje tokena B', async () => {
      const projects = app.get(ProjectsService);
      const projectId = (await projects.resolveByToken(token))!.project.id;
      const createdA = await projects.createToken(projectId, 'rate-limit-a-e2e');
      const createdB = await projects.createToken(projectId, 'rate-limit-b-e2e');

      await withClient(createdA.token, undefined, async (clientA) => {
        // RATE_LIMIT_SAVE_PER_MIN domyślnie 20 — bucket startuje PEŁNY (§token-bucket.ts). Wołane
        // WSPÓŁBIEŻNIE (Promise.allSettled), nie sekwencyjnie — każdy save_memory blokuje ~1.5s na
        // budżecie embeddingu (provider nieosiągalny w tym środowisku testowym), więc sekwencyjne
        // wywołania dałyby bucketowi minuty na dopełnienie między kolejnymi próbami i test nigdy nie
        // trafiłby w limit. Współbieżnie: guard konsumuje bucket przy KAŻDYM request (synchronicznie,
        // przed jakimkolwiek I/O), więc 25 równoległych wywołań trafia w niego w praktycznie tym samym
        // oknie czasu — refill w tym oknie jest pomijalny (≪1 tokena).
        const results = await Promise.allSettled(
          Array.from({ length: 25 }, (_, i) =>
            clientA.callTool({
              name: 'save_memory',
              arguments: { header: `Rate limit e2e ${i}`, body: `Treść ${i}.` },
            }),
          ),
        );
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        // Nie przypinamy się do DOKŁADNIE 20 — realny per-request I/O latency (embedding budżet) +
        // ograniczona współbieżność klienta HTTP dają trochę czasu na refill między pierwszym a
        // ostatnim requestem, więc dokładna granica pływa o kilka sztuk. Właściwość, którą tu
        // sprawdzamy, to: limit REALNIE istnieje (część requestów odrzucona) i nie jest nieskończony
        // (nie wszystkie 25 przeszło).
        expect(rejected.length).toBeGreaterThan(0);
        expect(fulfilled.length).toBeLessThan(25);
      });

      // Token B (świeży bucket, osobny klucz) NIE jest throttlowany przez wyczerpanie A.
      await withClient(createdB.token, undefined, async (clientB) => {
        const res = await clientB.callTool({
          name: 'save_memory',
          arguments: { header: 'Rate limit e2e — token B', body: 'Token B nie powinien być throttlowany.' },
        });
        expect(res.isError).not.toBe(true);
      });
    });
  });
});
