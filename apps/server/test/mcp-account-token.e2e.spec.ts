import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { desc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../src/db/db.tokens';
import { auditLog, memories, projectTokens, proposals, searchEvents } from '../src/db/schema';
import { rateLimitKey } from '../src/mcp/mcp-rate-limit.guard';
import { MemoryService } from '../src/memory/memory.service';
import { ONBOARD_PROMPT_TEXT, ONBOARDING_SETUP_STEPS } from '../src/onboarding/onboarding-templates';
import { ProjectsService } from '../src/projects/projects.service';
import { ProposalsService } from '../src/proposals/proposals.service';
import { MEMORY_TOOLS, RateLimiterService } from '../src/rate-limit/rate-limiter.service';
import { startMcpE2eApp, type McpE2eApp } from './helpers/mcp-app';
import { envelopeOf, mcpClients, textOf } from './helpers/mcp-client';

/**
 * MCP e2e dla v1.5 — token konta (`project_id IS NULL`) + nagłówek `X-Context-Keeper-Project`
 * (wydzielone z `mcp.e2e.spec.ts`; własny kontener i własny projekt `mcp-e2e` z tokenem projektowym).
 */
describe('MCP e2e v1.5 — token konta + X-Context-Keeper-Project', () => {
  const PROJECT_Y_SLUG = 'mcp-e2e-y';
  const Y_MARKER = 'ymarkerredis42';

  let mcpApp: McpE2eApp;
  let app: NestExpressApplication;
  let baseUrl: string;
  let token: string; // token projektowy projektu X (`mcp-e2e`)
  let projectXId: string;
  let projectYId: string;
  let projectYToken: string; // token projektowy projektu Y (`mcp-e2e-y`)
  let accountToken: string;
  let accountTokenId: string;
  const { withClient } = mcpClients(() => baseUrl);
  const ACCOUNT_TOOL_NAMES = ['create_project', 'get_memory', 'list_projects', 'save_memory', 'search_memory'];
  const PROJECT_TOOL_NAMES = ['get_memory', 'save_memory', 'search_memory'];

  beforeAll(async () => {
    mcpApp = await startMcpE2eApp();
    app = mcpApp.app;
    baseUrl = mcpApp.baseUrl;

    const projects = app.get(ProjectsService);
    const x = await projects.createProject('mcp-e2e');
    token = x.token;
    projectXId = x.project.id;
    await app.get(MemoryService).devSeedApproved({
      header: 'Postgres wymaga rozszerzenia pgvector',
      body: 'W testach uzywamy obrazu pgvector/pgvector:pg18-trixie w testcontainers.',
      kind: 'fact',
      tags: ['postgres', 'pgvector'],
      scope: 'project',
      projectId: projectXId,
    });

    const y = await projects.createProject('mcp-e2e-y');
    expect(y.project.slug).toBe(PROJECT_Y_SLUG);
    projectYId = y.project.id;
    projectYToken = y.token;
    await app.get(MemoryService).devSeedApproved({
      header: `Redis działa w projekcie Y ${Y_MARKER}`,
      body: `Fakt widoczny wyłącznie w projekcie Y (${Y_MARKER}).`,
      kind: 'fact',
      tags: ['redis'],
      scope: 'project',
      projectId: projectYId,
    });
    const account = await projects.createAccountToken('account-e2e');
    accountToken = account.token;
    accountTokenId = account.tokenRow.id;
  }, 180_000);

  afterAll(async () => {
    await mcpApp?.stop();
  });

  /** Surowy POST `/mcp` (bez klienta SDK) — porównanie statusu i treści 401 bajt-w-bajt. */
  async function rawPost(bearer: string | undefined): Promise<{ status: number; body: string }> {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    return { status: res.status, body: await res.text() };
  }

  async function countRows(): Promise<{ searchEvents: number; proposals: number; audit: number }> {
    const db = app.get<Database>(DB);
    const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(searchEvents);
    const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(proposals);
    const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    return { searchEvents: s.n, proposals: p.n, audit: a.n };
  }

  it('token konta + nagłówek: search widzi projekt X (nie Y), get_memory działa', async () => {
    await withClient(accountToken, 'mcp-e2e', async (client) => {
      const res = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      expect(res.isError).not.toBe(true);
      const results = JSON.parse(textOf(res as CallToolResult)) as Array<{ id: string; header: string }>;
      expect(results.some((r) => r.header.includes('pgvector'))).toBe(true);
      expect((results as Array<Record<string, unknown>>).every((r) => !('project' in r))).toBe(true); // tryb domyślny: bez pola project

      const other = await client.callTool({ name: 'search_memory', arguments: { query: Y_MARKER } });
      expect(JSON.parse(textOf(other as CallToolResult))).toEqual([]); // seed Y niewidoczny w X

      const got = await client.callTool({ name: 'get_memory', arguments: { id: results[0].id } });
      expect(got.isError).not.toBe(true);
    });
  });

  it('token konta + nagłówek Y: widzi seed Y; get_memory id z X -> body (G6), a tokenem projektowym Y -> not_found', async () => {
    const xId = await withClient(accountToken, 'mcp-e2e', async (clientX) => {
      const res = await clientX.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      return (JSON.parse(textOf(res as CallToolResult)) as Array<{ id: string }>)[0].id;
    });

    await withClient(accountToken, PROJECT_Y_SLUG, async (client) => {
      const res = await client.callTool({ name: 'search_memory', arguments: { query: Y_MARKER } });
      const results = JSON.parse(textOf(res as CallToolResult)) as Array<{ header: string }>;
      expect(results.some((r) => r.header.includes(Y_MARKER))).toBe(true);

      // Token konta czyta pamięć dowolnego projektu (roadmap v1.5, G6) — nagłówek Y niczego tu nie zawęża.
      const foreign = await client.callTool({ name: 'get_memory', arguments: { id: xId } });
      expect(foreign.isError).not.toBe(true);
      expect((JSON.parse(textOf(foreign as CallToolResult)) as { id: string }).id).toBe(xId);
    });

    // Token projektowy zostaje przy scope'ie projekt+global: cudzy id nadal daje not_found.
    await withClient(projectYToken, undefined, async (client) => {
      const foreign = await client.callTool({ name: 'get_memory', arguments: { id: xId } });
      expect(foreign.isError).toBe(true);
      expect(envelopeOf(foreign).code).toBe('not_found');
    });
  });

  it('save_memory tokenem konta: pending, audit actor=agent:<X>, metadata = token konta; search_events z project_id X', async () => {
    await withClient(accountToken, 'mcp-e2e', async (client) => {
      const saveRes = await client.callTool({
        name: 'save_memory',
        arguments: { header: 'Fakt zapisany tokenem konta e2e', body: 'Treść zapisana tokenem konta.', tags: ['e2e'] },
      });
      expect(saveRes.isError).not.toBe(true);
      expect((JSON.parse(textOf(saveRes as CallToolResult)) as { status: string }).status).toBe('pending');
      await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
    });

    const db = app.get<Database>(DB);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, 'proposal_created'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit.actor).toBe(`agent:${projectXId}`);
    const metadata = audit.metadata as { tokenId?: string; tokenLabel?: string };
    expect(metadata.tokenId).toBe(accountTokenId);
    expect(metadata.tokenLabel).toBe('account-e2e');

    const [event] = await db
      .select()
      .from(searchEvents)
      .where(eq(searchEvents.tokenId, accountTokenId))
      .orderBy(desc(searchEvents.createdAt))
      .limit(1);
    expect(event.projectId).toBe(projectXId);
    expect(event.tokenId).toBe(accountTokenId);
  });

  it("token konta + nagłówek z białymi znakami i wielkimi literami ('MCP-E2E ') rozwiązuje się jak mcp-e2e", async () => {
    await withClient(accountToken, 'MCP-E2E ', async (client) => {
      const res = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      expect(res.isError).not.toBe(true);
      expect((JSON.parse(textOf(res as CallToolResult)) as unknown[]).length).toBeGreaterThan(0);
    });
  });

  it('token konta bez nagłówka: połączenie OK, 5 narzędzi, memory tools -> project_required + details.projects, zero skutków ubocznych', async () => {
    // `withClient` łączy się bez nagłówka — HTTP 200, brak nagłówka NIE jest błędem transportu.
    await withClient(accountToken, undefined, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(ACCOUNT_TOOL_NAMES);

      const before = await countRows();

      const search = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      expect(search.isError).toBe(true);
      const envelope = envelopeOf(search);
      expect(envelope.code).toBe('project_required');
      expect(envelope.details?.projects).toEqual(
        expect.arrayContaining([
          { slug: 'mcp-e2e', name: 'mcp-e2e' },
          { slug: PROJECT_Y_SLUG, name: 'mcp-e2e-y' },
        ]),
      );
      expect(envelope.message).toContain('mcp-e2e');

      const save = await client.callTool({
        name: 'save_memory',
        arguments: { header: 'Nie powinno powstać', body: 'Bez projektu nic nie powstaje.' },
      });
      expect(save.isError).toBe(true);
      expect(envelopeOf(save).code).toBe('project_required');

      const get = await client.callTool({ name: 'get_memory', arguments: { id: 'mem_whatever0000' } });
      expect(envelopeOf(get).code).toBe('project_required');

      expect(await countRows()).toEqual(before); // brak search_events / proposals / audit_log
    });
  });

  it('token konta + nieznany slug -> project_not_found + details.projects; zły format też, bez skutków ubocznych', async () => {
    const before = await countRows();
    await withClient(accountToken, 'nope-zzz', async (client) => {
      const res = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      expect(res.isError).toBe(true);
      const envelope = envelopeOf(res);
      expect(envelope.code).toBe('project_not_found');
      expect(envelope.message).toContain('nope-zzz');
      expect(envelope.details?.projects?.some((p) => p.slug === 'mcp-e2e')).toBe(true);
    });

    await withClient(accountToken, 'Not A Slug!', async (badClient) => {
      const res = await badClient.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      const envelope = envelopeOf(res);
      expect(envelope.code).toBe('project_not_found');
      expect(envelope.message).not.toContain('Not A Slug'); // brak echa niepoprawnej wartości
      expect(envelope.details?.projects).toBeDefined();
    });
    expect(await countRows()).toEqual(before);
  });

  it('zmiana slugu (updateSlug): stary nagłówek -> project_not_found z nowym slugiem na liście, nowy działa (bez cache slugu)', async () => {
    const projects = app.get(ProjectsService);
    const { project } = await projects.createProject('mcp-e2e-rename');
    expect(project.slug).toBe('mcp-e2e-rename');
    await withClient(accountToken, 'mcp-e2e-rename', async (client) => {
      const res = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      expect(res.isError).not.toBe(true);
    });

    await projects.updateSlug(project.id, 'renamed');

    await withClient(accountToken, 'mcp-e2e-rename', async (client) => {
      const res = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      expect(res.isError).toBe(true);
      const envelope = envelopeOf(res);
      expect(envelope.code).toBe('project_not_found');
      expect(envelope.details?.projects?.some((p) => p.slug === 'renamed')).toBe(true);
    });
    await withClient(accountToken, 'renamed', async (client) => {
      const res = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      expect(res.isError).not.toBe(true);
    });
  });

  it('token projektowy + własny slug: działa jak bez nagłówka', async () => {
    await withClient(token, 'mcp-e2e', async (client) => {
      const res = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      expect(res.isError).not.toBe(true);
      expect((JSON.parse(textOf(res as CallToolResult)) as unknown[]).length).toBeGreaterThan(0);
    });
  });

  it('token projektowy + slug INNEGO projektu i + slug nieistniejący -> identyczny project_forbidden bez details', async () => {
    const before = await countRows();
    const envelopes: Array<ReturnType<typeof envelopeOf>> = [];
    for (const slug of [PROJECT_Y_SLUG, 'nope-zzz']) {
      await withClient(token, slug, async (client) => {
        const res = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
        expect(res.isError).toBe(true);
        envelopes.push(envelopeOf(res));
      });
    }
    expect(envelopes[0].code).toBe('project_forbidden');
    expect(envelopes[0].details).toBeUndefined();
    expect(envelopes[1]).toEqual(envelopes[0]); // niezależnie od istnienia slugu
    expect(envelopes[0].message).not.toContain(PROJECT_Y_SLUG);
    expect(await countRows()).toEqual(before);
  });

  it('zły / wygasły / unieważniony token (konta i projektowy) -> identyczny 401 jak garbage', async () => {
    const projects = app.get(ProjectsService);
    const db = app.get<Database>(DB);

    const garbage = await rawPost('ck_' + 'x'.repeat(43));
    expect(garbage.status).toBe(401);
    const missing = await rawPost(undefined);
    expect(missing.status).toBe(401);

    const revokedAccount = await projects.createAccountToken('revoked-account-e2e');
    await projects.revokeToken(revokedAccount.tokenRow.id);

    const expiredAccount = await projects.createAccountToken('expired-account-e2e');
    await projects.rotateToken(expiredAccount.tokenRow.id);
    await db
      .update(projectTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(projectTokens.id, expiredAccount.tokenRow.id));

    const revokedProject = await projects.createToken(projectXId, 'revoked-project-e2e');
    await projects.revokeToken(revokedProject.tokenRow.id);

    for (const bearer of [revokedAccount.token, expiredAccount.token, revokedProject.token]) {
      const res = await rawPost(bearer);
      expect(res.status).toBe(401);
      expect(res.body).toBe(garbage.body);
    }
  });

  it('rotacja tokenu konta: stary+nowy działają w grace, po wygaśnięciu stary 401, revoke nowego -> natychmiastowy 401', async () => {
    const projects = app.get(ProjectsService);
    const db = app.get<Database>(DB);
    const original = await projects.createAccountToken('rotation-account-e2e');
    const rotated = await projects.rotateToken(original.tokenRow.id);

    for (const bearer of [original.token, rotated.token]) {
      await withClient(bearer, 'mcp-e2e', async (client) => {
        const res = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
        expect(res.isError).not.toBe(true);
      });
    }

    await db
      .update(projectTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(projectTokens.id, original.tokenRow.id));
    await expect(withClient(original.token, 'mcp-e2e', async () => undefined)).rejects.toThrow();

    await withClient(rotated.token, 'mcp-e2e', async (liveClient) => {
      const res = await liveClient.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
      expect(res.isError).not.toBe(true);
    });

    await projects.revokeToken(rotated.tokenRow.id);
    await expect(withClient(rotated.token, 'mcp-e2e', async () => undefined)).rejects.toThrow();
  });

  it('rate limit per projekt: wyczerpanie save_memory tokenem konta w X nie throttluje tego tokena w Y', async () => {
    const projects = app.get(ProjectsService);
    const dedicated = await projects.createAccountToken('rate-limit-account-e2e');

    // Deterministycznie: opróżniamy bucket `tokenId:projectX:save_memory` bezpośrednio w
    // RateLimiterService (ten sam klucz, który składa guard — `rateLimitKey`), zamiast liczyć na
    // współbieżne HTTP-owe wywołania: przy obciążonej puli DB (wolne save'y z poprzednich testów)
    // żądania rozjeżdżały się w czasie na tyle, że bucket się dopełniał i test pływał.
    const limiter = app.get(RateLimiterService);
    const bucketKey = rateLimitKey(
      {
        tokenId: dedicated.tokenRow.id,
        tokenLabel: dedicated.tokenRow.label,
        tokenScope: 'account',
        project: { status: 'resolved', context: { projectId: projectXId, projectName: 'rate-limit-x' } },
      },
      'save_memory',
    );
    if (!bucketKey) throw new Error('rateLimitKey zwrócił null dla rozwiązanego projektu');
    let consumed = 0;
    while (limiter.tryConsume(bucketKey, 'save_memory').allowed) {
      if (++consumed > 1000) throw new Error('bucket save_memory nie wyczerpał się');
    }

    await withClient(dedicated.token, 'mcp-e2e', async (clientX) => {
      // X: wyczerpany budżet → HTTP 429 (klient SDK odrzuca wywołanie).
      await expect(
        clientX.callTool({ name: 'save_memory', arguments: { header: 'Rate limit konto X', body: 'Zablokowane.' } }),
      ).rejects.toThrow();
    });

    await withClient(dedicated.token, PROJECT_Y_SLUG, async (clientY) => {
      const res = await clientY.callTool({
        name: 'save_memory',
        arguments: { header: 'Rate limit konto Y', body: 'Projekt Y ma własny budżet tego tokena.' },
      });
      expect(res.isError).not.toBe(true);
    });
  });

  it('opisy narzędzi pamięci niosą cztery kody błędów scope’u, wzmianki o list_projects/create_project i opis 429 per token', async () => {
    await withClient(accountToken, undefined, async (client) => {
      const { tools } = await client.listTools();
      const memoryTools = tools.filter((t) => (MEMORY_TOOLS as readonly string[]).includes(t.name));
      expect(memoryTools).toHaveLength(3);
      for (const tool of memoryTools) {
        for (const code of ['project_required', 'project_not_found', 'project_pending', 'project_forbidden']) {
          expect(tool.description, `${tool.name} → ${code}`).toContain(code);
        }
        expect(tool.description).toContain('X-Context-Keeper-Project');
        expect(tool.description, `${tool.name} → list_projects`).toContain('list_projects');
        expect(tool.description, `${tool.name} → create_project`).toContain('create_project');
      }
      const save = memoryTools.find((t) => t.name === 'save_memory')!;
      expect(save.description).toMatch(/per token and per tool/);
    });
  });

  describe('cross-project search (roadmap v1.5, "Wyszukiwanie między projektami")', () => {
    interface SearchHit {
      id: string;
      header: string;
      project?: string | null;
    }
    const searchCall = (client: Client, args: Record<string, unknown>) =>
      client.callTool({ name: 'search_memory', arguments: { query: 'pgvector', ...args } });
    const hitsOf = (res: unknown): SearchHit[] => JSON.parse(textOf(res as CallToolResult)) as SearchHit[];

    /** Najnowszy `search_events` danego tokena (każdy test używa tokena konta, a testy lecą sekwencyjnie). */
    async function latestSearchEvent(tokenId: string) {
      const db = app.get<Database>(DB);
      const [row] = await db
        .select()
        .from(searchEvents)
        .where(eq(searchEvents.tokenId, tokenId))
        .orderBy(desc(searchEvents.createdAt))
        .limit(1);
      return row;
    }

    async function pgvectorFactIdFromX(): Promise<string> {
      return withClient(accountToken, 'mcp-e2e', async (client) => {
        const hit = hitsOf(await searchCall(client, {})).find((r) => r.header.includes('pgvector'));
        if (!hit) throw new Error('seed pgvector w projekcie X nie znaleziony');
        return hit.id;
      });
    }

    it('AC1: token konta + nagłówek Y + all_projects:true -> trafienie z X z project="mcp-e2e", każdy wynik ma klucz project; FTS-only (degraded)', async () => {
      await withClient(accountToken, PROJECT_Y_SLUG, async (client) => {
        const res = await searchCall(client, { all_projects: true });
        expect(res.isError).not.toBe(true);
        const hits = hitsOf(res);
        const xFact = hits.find((r) => r.header.includes('pgvector'));
        expect(xFact).toBeDefined();
        expect(xFact!.project).toBe('mcp-e2e');
        expect(hits.every((r) => 'project' in r)).toBe(true);

        // Seed Y też jest widoczny (cross = wszystkie projekty), z własnym slugiem.
        const yHits = hitsOf(await searchCall(client, { query: Y_MARKER, all_projects: true }));
        expect(yHits.find((r) => r.header.includes(Y_MARKER))?.project).toBe(PROJECT_Y_SLUG);
      });

      // Środowisko e2e nie ma osiągalnego providera embeddingów -> ramię wektorowe pominięte, więc
      // powyższe trafienie przyszło z samego ramienia FTS (dowód `degraded`).
      expect((await latestSearchEvent(accountTokenId)).degraded).toBe(true);
    });

    it('AC2: bez parametru i z all_projects:false -> tylko Y + global, bez pola project, odpowiedź identyczna', async () => {
      await withClient(accountToken, PROJECT_Y_SLUG, async (client) => {
        const byDefault = await searchCall(client, {});
        const explicitFalse = await searchCall(client, { all_projects: false });
        expect(hitsOf(byDefault).some((r) => r.header.includes('pgvector'))).toBe(false); // X niewidoczny z Y
        expect(hitsOf(byDefault).every((r) => !('project' in r))).toBe(true);
        expect(textOf(byDefault as CallToolResult)).toBe(textOf(explicitFalse as CallToolResult));

        const own = hitsOf(await searchCall(client, { query: Y_MARKER }));
        expect(own.some((r) => r.header.includes(Y_MARKER))).toBe(true);
        expect(own.every((r) => !('project' in r))).toBe(true);
      });
    });

    it('AC3: token projektowy + all_projects:true -> validation_error (account token), zero skutków ubocznych; bez parametru działa', async () => {
      await withClient(token, 'mcp-e2e', async (client) => {
        const before = await countRows();
        const res = await searchCall(client, { all_projects: true });
        expect(res.isError).toBe(true);
        const envelope = envelopeOf(res);
        expect(envelope.code).toBe('validation_error');
        expect(envelope.message).toContain('account token');
        expect(await countRows()).toEqual(before); // brak search_events

        const fine = await searchCall(client, {});
        expect(fine.isError).not.toBe(true);
        expect(hitsOf(fine).some((r) => r.header.includes('pgvector'))).toBe(true);
        expect(hitsOf(fine).every((r) => !('project' in r))).toBe(true);

        const explicitFalse = await searchCall(client, { all_projects: false });
        expect(explicitFalse.isError).not.toBe(true);
      });
    });

    it('AC4: token konta bez nagłówka + all_projects:true -> project_required z details.projects, zero skutków ubocznych', async () => {
      await withClient(accountToken, undefined, async (client) => {
        const before = await countRows();
        const res = await searchCall(client, { all_projects: true });
        expect(res.isError).toBe(true);
        const envelope = envelopeOf(res);
        expect(envelope.code).toBe('project_required');
        expect(envelope.details?.projects?.some((p) => p.slug === PROJECT_Y_SLUG)).toBe(true);
        expect(await countRows()).toEqual(before);
      });
    });

    it('AC5: inputSchema search_memory ma all_projects dla obu typów tokena; opis jedną stałą z parametrem, tokenem konta i polem project; get_memory wspomina token konta', async () => {
      const seen: Array<{ search: string; get: string }> = [];
      for (const [bearer, slug] of [
        [accountToken, undefined],
        [accountToken, 'mcp-e2e'],
        [token, undefined],
        [token, 'mcp-e2e'],
      ] as const) {
        await withClient(bearer, slug, async (client) => {
          const { tools } = await client.listTools();
          const search = tools.find((t) => t.name === 'search_memory')!;
          const get = tools.find((t) => t.name === 'get_memory')!;
          expect(Object.keys(search.inputSchema.properties ?? {}).sort()).toEqual([
            'all_projects',
            'kind',
            'query',
            'tags',
          ]);
          expect(search.description).toContain('all_projects');
          expect(search.description).toContain('account token');
          expect(search.description).toContain('`project`');
          expect(get.description).toContain('account token');
          seen.push({ search: search.description ?? '', get: get.description ?? '' });
        });
      }
      for (const d of seen) expect(d).toEqual(seen[0]); // opis niezależny od typu tokena
    });

    it('AC8: get_memory id z X tokenem konta (nagłówek Y) -> body + bump access_count; token projektowy Y -> not_found', async () => {
      const xId = await pgvectorFactIdFromX();
      const db = app.get<Database>(DB);
      const accessCount = async () => {
        const [row] = await db
          .select({ n: memories.accessCount })
          .from(memories)
          .where(eq(memories.id, xId));
        return row.n;
      };
      const before = await accessCount();

      await withClient(accountToken, PROJECT_Y_SLUG, async (client) => {
        const got = await client.callTool({ name: 'get_memory', arguments: { id: xId } });
        expect(got.isError).not.toBe(true);
        const body = JSON.parse(textOf(got as CallToolResult)) as { id: string; body: string };
        expect(body.id).toBe(xId);
        expect(body.body).toContain('pgvector/pgvector:pg18-trixie');
      });
      expect(await accessCount()).toBe(before + 1);

      await withClient(projectYToken, undefined, async (client) => {
        const foreign = await client.callTool({ name: 'get_memory', arguments: { id: xId } });
        expect(foreign.isError).toBe(true);
        expect(envelopeOf(foreign).code).toBe('not_found');
      });
      expect(await accessCount()).toBe(before + 1); // odrzucony odczyt niczego nie bumpuje
    });

    it('AC9: save_memory tokenem konta (nagłówek Y) z supersedes / relations na id z X -> not_found (inScope nietknięty)', async () => {
      const xId = await pgvectorFactIdFromX();
      await withClient(accountToken, PROJECT_Y_SLUG, async (client) => {
        const before = await countRows();

        const supersede = await client.callTool({
          name: 'save_memory',
          arguments: { header: 'Korekta cudzego faktu', body: 'Nie powinno powstać.', supersedes: xId },
        });
        expect(supersede.isError).toBe(true);
        expect(envelopeOf(supersede).code).toBe('not_found');

        const relate = await client.callTool({
          name: 'save_memory',
          arguments: {
            header: 'Relacja do cudzego faktu',
            body: 'Nie powinno powstać.',
            relations: [{ type: 'follows', targetId: xId }],
          },
        });
        expect(relate.isError).toBe(true);
        expect(envelopeOf(relate).code).toBe('not_found');

        expect(await countRows()).toEqual(before); // żaden proposal ani wpis audytu
      });
    });

    it('AC10: wywołanie cross = jeden wiersz search_events (project=Y, token konta, cross_project=true), bez wpisu w audit_log; zwykłe -> false', async () => {
      await withClient(accountToken, PROJECT_Y_SLUG, async (client) => {
        const before = await countRows();
        await searchCall(client, { all_projects: true });
        const afterCross = await countRows();
        expect(afterCross.searchEvents).toBe(before.searchEvents + 1);
        expect(afterCross.audit).toBe(before.audit);
        const crossEvent = await latestSearchEvent(accountTokenId);
        expect(crossEvent.projectId).toBe(projectYId);
        expect(crossEvent.tokenId).toBe(accountTokenId);
        expect(crossEvent.crossProject).toBe(true);

        await searchCall(client, {});
        const afterNormal = await countRows();
        expect(afterNormal.searchEvents).toBe(afterCross.searchEvents + 1);
        expect((await latestSearchEvent(accountTokenId)).crossProject).toBe(false);
      });
    });

    it('AC12: cross zużywa ten sam kubełek search_memory tokenId:projekt z nagłówka — po jego wyczerpaniu 429', async () => {
      const dedicated = await app.get(ProjectsService).createAccountToken('rate-limit-cross-e2e');
      const limiter = app.get(RateLimiterService);
      const bucketKey = rateLimitKey(
        {
          tokenId: dedicated.tokenRow.id,
          tokenLabel: dedicated.tokenRow.label,
          tokenScope: 'account',
          project: { status: 'resolved', context: { projectId: projectYId, projectName: 'mcp-e2e-y' } },
        },
        'search_memory',
      );
      if (!bucketKey) throw new Error('rateLimitKey zwrócił null dla rozwiązanego projektu');
      let consumed = 0;
      while (limiter.tryConsume(bucketKey, 'search_memory').allowed) {
        if (++consumed > 1000) throw new Error('bucket search_memory nie wyczerpał się');
      }

      await withClient(dedicated.token, PROJECT_Y_SLUG, async (client) => {
        await expect(searchCall(client, { all_projects: true })).rejects.toThrow();
      });
    });
  });

  describe('narzędzia konta — list_projects / create_project (roadmap v1.5, scope B)', () => {
    const TOKEN_LIKE = /ck_[A-Za-z0-9_-]{20,}/;

    /** Każdy test `create_project` dostaje WŁASNY token konta: limit `create_project` to 3/min na
     * `tokenId:account` (a wywołania odrzucone walidacją też zużywają budżet — guard biegnie wcześniej). */
    async function freshAccountToken(label: string): Promise<{ token: string; tokenId: string }> {
      const created = await app.get(ProjectsService).createAccountToken(label);
      return { token: created.token, tokenId: created.tokenRow.id };
    }

    interface CreateResult {
      status: string;
      proposalId: string;
      project: { slug: string; name: string };
      mcpJson: string;
      agentsMd: string;
      claudeMd: string;
      mcpUrlConfigured: boolean;
      next: string;
    }
    interface ListResult {
      projects: Array<{ slug: string; name: string; mcpJson: string }>;
      agentsMd: string;
      claudeMd: string;
      mcpUrlConfigured: boolean;
      hint: string;
    }

    const createProjectCall = (client: Client, args: { name: string; slug: string }) =>
      client.callTool({ name: 'create_project', arguments: args });
    const listProjectsCall = async (client: Client): Promise<ListResult> =>
      JSON.parse(textOf((await client.callTool({ name: 'list_projects', arguments: {} })) as CallToolResult));
    const parseCreate = (res: unknown): CreateResult => JSON.parse(textOf(res as CallToolResult));

    it('tools/list: token konta (bez nagłówka i z nagłówkiem) -> 5 narzędzi; token projektowy (bez i z własnym nagłówkiem) -> 3', async () => {
      for (const [bearer, slug, expected] of [
        [accountToken, undefined, ACCOUNT_TOOL_NAMES],
        [accountToken, 'mcp-e2e', ACCOUNT_TOOL_NAMES],
        [accountToken, 'nope-zzz', ACCOUNT_TOOL_NAMES], // zestaw nie zależy od stanu projektu
        [token, undefined, PROJECT_TOOL_NAMES],
        [token, 'mcp-e2e', PROJECT_TOOL_NAMES],
      ] as const) {
        await withClient(bearer, slug, async (client) => {
          const { tools } = await client.listTools();
          expect(tools.map((t) => t.name).sort(), `${slug ?? 'no header'}`).toEqual(expected);
        });
      }
    });

    it('opisy narzędzi konta: bez tokena; create_project = human-gated propozycja z regułą slugu', async () => {
      await withClient(accountToken, undefined, async (client) => {
        const { tools } = await client.listTools();
        const list = tools.find((t) => t.name === 'list_projects')!;
        const create = tools.find((t) => t.name === 'create_project')!;
        expect(list.description).toMatch(/account token/i);
        expect(list.description).toContain('CONTEXT_KEEPER_TOKEN');
        expect(create.description).toMatch(/human/i);
        expect(create.description).toContain('^[a-z0-9]+(-[a-z0-9]+)*$');
        expect(create.description).toContain('validation_error');
        expect(create.description).toMatch(/does NOT create the project immediately/);
        for (const t of [list, create]) expect(t.description).not.toMatch(TOKEN_LIKE);
      });
    });

    it('list_projects: istniejące projekty z gotowym mcpJson (nagłówek = slug, Authorization = placeholder); odpowiedź bez tokena', async () => {
      await withClient(accountToken, undefined, async (client) => {
        const res = await client.callTool({ name: 'list_projects', arguments: {} });
        expect(res.isError).not.toBe(true);
        const text = textOf(res as CallToolResult);
        const body = JSON.parse(text) as ListResult;

        const slugs = body.projects.map((p) => p.slug);
        expect(slugs).toEqual(expect.arrayContaining(['mcp-e2e', PROJECT_Y_SLUG]));
        expect(slugs).toEqual([...slugs].sort());
        for (const p of body.projects) {
          const entry = (
            JSON.parse(p.mcpJson) as { mcpServers: Record<string, { headers: Record<string, string> }> }
          ).mcpServers['context-keeper'];
          expect(entry.headers['X-Context-Keeper-Project']).toBe(p.slug);
          expect(entry.headers.Authorization).toBe('Bearer ${CONTEXT_KEEPER_TOKEN}');
        }
        expect(body.agentsMd).toContain('search_memory');
        expect(body.claudeMd).toContain('@AGENTS.md');
        expect(typeof body.hint).toBe('string');
        expect(body.hint).toContain(ONBOARDING_SETUP_STEPS);
        expect(text).not.toContain(accountToken);
        expect(text).not.toMatch(TOKEN_LIKE);
      });
    });

    it('create_project: pending + proposalId; wiersz proposals (global, bez projektu), audyt agent:account z atrybucją; bez tokena w odpowiedzi', async () => {
      const acc = await freshAccountToken('cp-create-e2e');
      await withClient(acc.token, undefined, async (client) => {
        const res = await createProjectCall(client, { name: '  E2E   New  ', slug: '  E2E-New ' });
        expect(res.isError).not.toBe(true);
        const text = textOf(res as CallToolResult);
        const body = JSON.parse(text) as CreateResult;
        expect(body.status).toBe('pending');
        expect(body.proposalId).toMatch(/^prop_/);
        expect(body.project).toEqual({ slug: 'e2e-new', name: 'E2E New' });
        expect(body.mcpJson).toContain('"X-Context-Keeper-Project": "e2e-new"');
        expect(body.next).toContain('project_pending');
        expect(body.next).toContain(ONBOARDING_SETUP_STEPS);
        expect(text).not.toContain(acc.token);
        expect(text).not.toMatch(TOKEN_LIKE);

        const db = app.get<Database>(DB);
        const [row] = await db.select().from(proposals).where(eq(proposals.id, body.proposalId));
        expect(row).toMatchObject({
          type: 'create_project',
          origin: 'agent',
          status: 'pending',
          scope: 'global',
          projectId: null,
          affectedIds: [],
          payload: { name: 'E2E New', slug: 'e2e-new' },
        });
        const [audit] = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.eventType, 'proposal_created'))
          .orderBy(desc(auditLog.createdAt))
          .limit(1);
        expect(audit.actor).toBe('agent:account');
        expect(audit.metadata).toMatchObject({
          proposalId: body.proposalId,
          type: 'create_project',
          slug: 'e2e-new',
          tokenId: acc.tokenId,
          tokenLabel: 'cp-create-e2e',
        });

        // Drugi raz ten sam slug (pending) i slug istniejącego projektu -> validation_error.
        const again = await createProjectCall(client, { name: 'E2E New again', slug: 'e2e-new' });
        expect(again.isError).toBe(true);
        expect(envelopeOf(again).code).toBe('validation_error');
        expect(envelopeOf(again).message).toContain('awaiting approval');

        const existing = await createProjectCall(client, { name: 'Dup', slug: 'mcp-e2e' });
        expect(existing.isError).toBe(true);
        expect(envelopeOf(existing).code).toBe('validation_error');
        expect(envelopeOf(existing).message).toContain('already exists');
      });
    });

    it("create_project: niepoprawny slug -> koperta validation_error (nie surowy błąd zod); '  New-One ' -> new-one", async () => {
      const acc = await freshAccountToken('cp-validation-e2e');
      await withClient(acc.token, undefined, async (client) => {
        const bad = await createProjectCall(client, { name: 'Bad Slug', slug: 'Not A Slug!' });
        expect(bad.isError).toBe(true);
        const envelope = envelopeOf(bad); // JSON-owa koperta {code, message}, nie tekst zoda
        expect(envelope.code).toBe('validation_error');
        expect(envelope.message).toContain('Invalid project slug');

        const ok = await createProjectCall(client, { name: 'New One', slug: '  New-One ' });
        expect(ok.isError).not.toBe(true);
        expect(parseCreate(ok).project.slug).toBe('new-one');
      });
    });

    it('create_project: sekret w nazwie -> secret_blocked', async () => {
      const acc = await freshAccountToken('cp-secret-e2e');
      await withClient(acc.token, undefined, async (client) => {
        const res = await createProjectCall(client, { name: 'AKIAABCDEFGHIJKLMNOP', slug: 'cp-secret-e2e' });
        expect(res.isError).toBe(true);
        expect(envelopeOf(res).code).toBe('secret_blocked');
      });
    });

    it('slug oczekującej propozycji -> memory tool z tym nagłówkiem zwraca project_pending (bez details, bez skutków ubocznych)', async () => {
      const acc = await freshAccountToken('cp-pending-e2e');
      await withClient(acc.token, undefined, async (client) => {
        const res = await createProjectCall(client, { name: 'Pending E2E', slug: 'e2e-pending' });
        expect(res.isError).not.toBe(true);
      });
      const before = await countRows();
      await withClient(acc.token, 'e2e-pending', async (client) => {
        const search = await client.callTool({ name: 'search_memory', arguments: { query: 'cokolwiek' } });
        expect(search.isError).toBe(true);
        const envelope = envelopeOf(search);
        expect(envelope.code).toBe('project_pending');
        expect(envelope.details).toBeUndefined();
        expect(envelope.message).toContain('create_project');
      });
      expect(await countRows()).toEqual(before);
    });

    it('approve w kolejce: projekt powstaje bez tokena; ta sama konfiguracja z nagłówkiem działa bez zmian (search = [], save = pending)', async () => {
      const acc = await freshAccountToken('cp-approve-e2e');
      let proposalId = '';
      let createdMcpJson = '';
      await withClient(acc.token, undefined, async (client) => {
        const body = parseCreate(await createProjectCall(client, { name: 'Approve E2E', slug: 'e2e-approve' }));
        proposalId = body.proposalId;
        createdMcpJson = body.mcpJson;
      });

      const approved = await app.get(ProposalsService).approve(proposalId, { actor: 'human-dashboard' });
      expect(approved.projectId).toBeDefined();
      expect(await app.get(ProjectsService).listTokens(approved.projectId!)).toEqual([]);

      await withClient(acc.token, 'e2e-approve', async (client) => {
        const search = await client.callTool({ name: 'search_memory', arguments: { query: 'pgvector' } });
        expect(search.isError).not.toBe(true);
        expect(JSON.parse(textOf(search as CallToolResult))).toEqual([]);

        const save = await client.callTool({
          name: 'save_memory',
          arguments: { header: 'Pierwszy fakt nowego projektu', body: 'Zapis w świeżo zatwierdzonym projekcie.' },
        });
        expect(save.isError).not.toBe(true);
        expect((JSON.parse(textOf(save as CallToolResult)) as { status: string }).status).toBe('pending');

        const entry = (await listProjectsCall(client)).projects.find((p) => p.slug === 'e2e-approve');
        expect(entry?.name).toBe('Approve E2E');
        expect(entry?.mcpJson).toBe(createdMcpJson); // te same bloki z create_project i list_projects
      });
    });

    it('reject zwalnia slug: ten sam create_project przechodzi ponownie', async () => {
      const acc = await freshAccountToken('cp-reject-e2e');
      await withClient(acc.token, undefined, async (client) => {
        const first = parseCreate(await createProjectCall(client, { name: 'Reject E2E', slug: 'e2e-reject' }));
        await app.get(ProposalsService).reject(first.proposalId, { actor: 'human-dashboard', reason: 'test' });

        const second = await createProjectCall(client, { name: 'Reject E2E', slug: 'e2e-reject' });
        expect(second.isError).not.toBe(true);
        const body = parseCreate(second);
        expect(body.status).toBe('pending');
        expect(body.proposalId).not.toBe(first.proposalId);
      });
    });

    it('bulk approve/reject po kolejce: propozycje create_project w succeeded', async () => {
      const acc = await freshAccountToken('cp-bulk-e2e');
      const ids: string[] = [];
      await withClient(acc.token, undefined, async (client) => {
        for (const slug of ['e2e-bulk-a', 'e2e-bulk-b', 'e2e-bulk-c']) {
          ids.push(parseCreate(await createProjectCall(client, { name: slug, slug })).proposalId);
        }
      });
      const proposalsService = app.get(ProposalsService);
      const approved = await proposalsService.bulkApprove(ids.slice(0, 2), { actor: 'human-dashboard' });
      expect(approved).toEqual({ succeeded: ids.slice(0, 2), failed: [] });
      const rejected = await proposalsService.bulkReject([ids[2]], { actor: 'human-dashboard', reason: 'bulk' });
      expect(rejected).toEqual({ succeeded: [ids[2]], failed: [] });

      await withClient(acc.token, undefined, async (client) => {
        const slugs = (await listProjectsCall(client)).projects.map((p) => p.slug);
        expect(slugs).toEqual(expect.arrayContaining(['e2e-bulk-a', 'e2e-bulk-b']));
        expect(slugs).not.toContain('e2e-bulk-c');
      });
    });

    it('anty-probing: token projektowy nie widzi ani nie wywoła narzędzi konta; brak skutków ubocznych', async () => {
      const before = await countRows();
      await withClient(token, 'mcp-e2e', async (client) => {
        for (const [name, args] of [
          ['list_projects', {}],
          ['create_project', { name: 'Intruder', slug: 'e2e-intruder' }],
        ] as const) {
          const outcome = await client.callTool({ name, arguments: args }).then(
            (r) => ({ rejected: false as const, result: r }),
            (e: unknown) => ({ rejected: true as const, error: e }),
          );
          // SDK zgłasza nieznane narzędzie albo jako błąd JSON-RPC, albo jako wynik z isError.
          const text = outcome.rejected
            ? String((outcome.error as Error).message)
            : textOf(outcome.result as CallToolResult);
          if (!outcome.rejected) expect(outcome.result.isError).toBe(true);
          expect(text).toMatch(/not found/i);
          expect(text).not.toContain(PROJECT_Y_SLUG); // żadnych cudzych slugów
        }
      });
      expect(await countRows()).toEqual(before);
      const db = app.get<Database>(DB);
      const rows = await db.select().from(proposals).where(eq(proposals.type, 'create_project'));
      expect(rows.some((r) => (r.payload as { slug: string }).slug === 'e2e-intruder')).toBe(false);
    });

    it('rate limit create_project: wyczerpany bucket tokenId:account -> 429; osobny token nietknięty', async () => {
      const acc = await freshAccountToken('cp-ratelimit-e2e');
      const other = await freshAccountToken('cp-ratelimit-other-e2e');
      const limiter = app.get(RateLimiterService);
      const key = rateLimitKey(
        {
          tokenId: acc.tokenId,
          tokenLabel: 'cp-ratelimit-e2e',
          tokenScope: 'account',
          project: { status: 'unresolved', reason: 'project_required' },
        },
        'create_project',
      );
      expect(key).toBe(`${acc.tokenId}:account`);
      let consumed = 0;
      while (limiter.tryConsume(key!, 'create_project').allowed) {
        if (++consumed > 100) throw new Error('bucket create_project nie wyczerpał się');
      }
      expect(consumed).toBe(3); // domyślny RATE_LIMIT_CREATE_PROJECT_PER_MIN

      await withClient(acc.token, undefined, async (client) => {
        await expect(createProjectCall(client, { name: 'Limited', slug: 'e2e-limited' })).rejects.toThrow();
      });
      const db = app.get<Database>(DB);
      const rows = await db.select().from(proposals).where(eq(proposals.type, 'create_project'));
      expect(rows.some((r) => (r.payload as { slug: string }).slug === 'e2e-limited')).toBe(false);

      await withClient(other.token, undefined, async (client) => {
        const res = await createProjectCall(client, { name: 'Not limited', slug: 'e2e-not-limited' });
        expect(res.isError).not.toBe(true);
      });
    });
  });

  describe('prompt MCP onboard (ticket mcp-onboard-prompt)', () => {
    it('prompts/list: token konta (bez nagłówka, z nagłówkiem, ze złym slugiem) -> capability prompts + dokładnie [onboard] bez argumentów', async () => {
      for (const [bearer, slug] of [
        [accountToken, undefined],
        [accountToken, 'mcp-e2e'],
        [accountToken, 'nope-zzz'], // prompt nie zależy od stanu projektu
      ] as const) {
        await withClient(bearer, slug, async (client) => {
          expect(client.getServerCapabilities()?.prompts, `${slug ?? 'no header'}`).toBeDefined();
          const { prompts } = await client.listPrompts();
          expect(prompts.map((p) => p.name)).toEqual(['onboard']);
          expect(prompts[0].arguments ?? []).toEqual([]);
        });
      }
    });

    it('token projektowy (bez i z własnym nagłówkiem): brak capability prompts; prompts/list i prompts/get odrzucone', async () => {
      for (const slug of [undefined, 'mcp-e2e'] as const) {
        await withClient(token, slug, async (client) => {
          expect(client.getServerCapabilities()?.prompts, `${slug ?? 'no header'}`).toBeUndefined();
          await expect(client.listPrompts()).rejects.toThrow();
          await expect(client.getPrompt({ name: 'onboard' })).rejects.toThrow();
        });
      }
    });

    it('prompts/get onboard: jedna wiadomość user/text = statyczny tekst, bez tokena, bez skutków w bazie', async () => {
      const before = await countRows();
      await withClient(accountToken, undefined, async (client) => {
        const res = await client.getPrompt({ name: 'onboard' });
        expect(res.messages).toHaveLength(1);
        const [message] = res.messages;
        expect(message.role).toBe('user');
        expect(message.content.type).toBe('text');
        const text = message.content.type === 'text' ? message.content.text : '';
        expect(text).toBe(ONBOARD_PROMPT_TEXT);
        expect(text).toContain(ONBOARDING_SETUP_STEPS);
        expect(text).not.toContain(accountToken);
        expect(text).not.toMatch(/ck_/);
      });
      expect(await countRows()).toEqual(before);
    });
  });
});
