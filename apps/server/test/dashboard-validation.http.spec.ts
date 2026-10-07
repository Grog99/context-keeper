import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { encodeKeysetCursor } from '../src/common/keyset-cursor';
import { AppConfigService } from '../src/config/config.service';
import { AccountTokensController } from '../src/dashboard/account-tokens.controller';
import { AuditController } from '../src/dashboard/audit.controller';
import { CsrfGuard } from '../src/dashboard/auth/csrf.guard';
import { SessionGuard } from '../src/dashboard/auth/session.guard';
import { ConfigController } from '../src/dashboard/config.controller';
import { DashboardErrorFilter } from '../src/dashboard/dashboard-error.filter';
import { MemoriesController } from '../src/dashboard/memories.controller';
import { NightlyController } from '../src/dashboard/nightly.controller';
import { OnboardingController } from '../src/dashboard/onboarding.controller';
import { ProjectsController } from '../src/dashboard/projects.controller';
import { ProposalsController } from '../src/dashboard/proposals.controller';
import { SettingsController } from '../src/dashboard/settings.controller';
import { UsageMetricsController } from '../src/dashboard/usage-metrics.controller';
import { LlmSettingsService } from '../src/llm/llm-settings.service';
import { LlmService } from '../src/llm/llm.service';
import { MemoryAdminService } from '../src/memory/memory-admin.service';
import { NightlyService } from '../src/nightly/nightly.service';
import { OnboardingService } from '../src/onboarding/onboarding.service';
import { ProjectsService } from '../src/projects/projects.service';
import { ProposalsService } from '../src/proposals/proposals.service';
import { PurgeService } from '../src/purge/purge.service';
import { UsageService } from '../src/usage/usage.service';

/**
 * Dowód wpięcia pipe'ów w realny potok HTTP Nesta (nie tylko jednostkowe wywołanie metody
 * kontrolera, które pomija pipe'y — tech-review #3, roadmap v1.4). Wzorzec jak `mcp.e2e.spec.ts`
 * (`app.listen(0, '127.0.0.1')` + globalny `fetch`), guardy nadpisane `overrideGuard(...).useValue`
 * (jak plan §6.3) — testujemy WYŁĄCZNIE warstwę walidacji, nie auth.
 */
let calls: string[] = [];

function track(name: string) {
  calls.push(name);
}

/** Ostatnie argumenty przekazane do fake'ów list (audyt/propozycje) — dowód, co faktycznie dotarło do serwisu. */
let lastAuditFilter: unknown;
let lastProposalsPageFilter: unknown;

function fakeMemoryAdmin(): MemoryAdminService {
  return {
    listMemories: async () => (track('memoryAdmin.listMemories'), []),
    listEvents: async () => (track('memoryAdmin.listEvents'), []),
    getMemoryDetail: async () => (track('memoryAdmin.getMemoryDetail'), {}),
    listRevisions: async () => (track('memoryAdmin.listRevisions'), []),
    listRelations: async () => (track('memoryAdmin.listRelations'), []),
    createRelation: async () => (track('memoryAdmin.createRelation'), { id: 'rel_new' }),
    removeRelation: async () => track('memoryAdmin.removeRelation'),
    humanCreate: async () => (track('memoryAdmin.humanCreate'), { id: 'mem_new', warnings: [] }),
    editMemory: async () => (track('memoryAdmin.editMemory'), { warnings: [] }),
    archiveMemory: async () => track('memoryAdmin.archiveMemory'),
    promoteToGlobal: async () => track('memoryAdmin.promoteToGlobal'),
  } as unknown as MemoryAdminService;
}

function fakePurge(): PurgeService {
  return {
    preview: async () => (track('purge.preview'), { id: 'mem_1', status: 'approved', header: 'h', embeddingsCount: 0, relatedProposalsCount: 0, revisionsWithContentCount: 0, relationsCount: 0 }),
    purge: async () => (track('purge.purge'), { id: 'mem_1', embeddingsDeleted: 0, stagingEmbeddingsDeleted: 0, proposalsRedacted: 0, revisionsRedacted: 0, relationsDeleted: 0 }),
  } as unknown as PurgeService;
}

function fakeAudit(): AuditService {
  return {
    query: async (filter: unknown) => (
      track('audit.query'),
      (lastAuditFilter = filter),
      { items: [], nextCursor: null }
    ),
    log: async () => track('audit.log'),
    countSince: async () => 0,
    latestByEventType: async () => null,
  } as unknown as AuditService;
}

function fakeProposals(): ProposalsService {
  return {
    listPending: async () => (track('proposals.listPending'), []),
    listPendingPage: async (filter: unknown) => (
      track('proposals.listPendingPage'),
      (lastProposalsPageFilter = filter),
      { items: [], nextCursor: null, total: 0 }
    ),
    getProposal: async () => (track('proposals.getProposal'), { id: 'prop_1' }),
    approve: async () => (track('proposals.approve'), { proposalId: 'prop_1', archivedIds: [], embedding: 'vectorless' }),
    reject: async () => track('proposals.reject'),
    edit: async () => (track('proposals.edit'), { warnings: [] }),
    bulkApprove: async () => (track('proposals.bulkApprove'), { succeeded: [], failed: [] }),
    bulkReject: async () => (track('proposals.bulkReject'), { succeeded: [], failed: [] }),
  } as unknown as ProposalsService;
}

function fakeProjects(): ProjectsService {
  return {
    listProjects: async () => [],
    countMemoriesByProject: async () => new Map(),
    countTokensByProject: async () => new Map(),
    createProject: async () => (track('projects.createProject'), { project: { id: 'proj_1', name: 'x' }, token: 't', tokenRow: { id: 'tok_1', label: 'default' } }),
    findById: async () => ({ id: 'proj_1', slug: 'proj-one', includeEventsInDefaultSearch: false }),
    updateProject: async () => (track('projects.updateProject'), { id: 'proj_1', includeEventsInDefaultSearch: true }),
    updateSlug: async (_id: string, slug: string) => (track(`projects.updateSlug:${slug}`), { id: 'proj_1', slug, includeEventsInDefaultSearch: false }),
    listAccountTokens: async () => [{ id: 'tok_acc1', projectId: null, label: 'laptop', status: 'active' }],
    createAccountToken: async () => (track('projects.createAccountToken'), { token: 't', tokenRow: { id: 'tok_accnew', label: 'x' } }),
    listTokens: async () => [{ id: 'tok_1', projectId: 'proj_1', label: 'default', status: 'active' }],
    createToken: async () => (track('projects.createToken'), { token: 't', tokenRow: { id: 'tok_new', label: 'x' } }),
    rotateToken: async () => (track('projects.rotateToken'), { token: 't', tokenRow: { id: 'tok_new' }, previousTokenRow: { id: 'tok_1' } }),
    revokeToken: async () => (track('projects.revokeToken'), { id: 'tok_1', status: 'revoked' }),
    updateTokenLabel: async () => (track('projects.updateTokenLabel'), { id: 'tok_1', label: 'renamed' }),
  } as unknown as ProjectsService;
}

function fakeUsage(): UsageService {
  return {
    searchSeries: async () => (track('usage.searchSeries'), []),
    proposalOutcomeSeries: async () => (track('usage.proposalOutcomeSeries'), []),
    countSearchesByToken: async () => new Map(),
    countSearchesByAccountTokens: async () => new Map(),
  } as unknown as UsageService;
}

function fakeOnboarding(): OnboardingService {
  return {
    forDashboard: async () => (track('onboarding.forDashboard'), { projects: [] }),
  } as unknown as OnboardingService;
}

function fakeNightly(): NightlyService {
  return {
    run: async () => (track('nightly.run'), { status: 'success', startedAt: '', finishedAt: '', durationMs: 0, counters: {} }),
  } as unknown as NightlyService;
}

const LLM_SENTINEL = 'sk-sentinel-DO-NOT-LEAK-http-77777';

function fakeLlmSettings(): LlmSettingsService {
  return {
    getPublic: async () => (track('llmSettings.getPublic'), {}),
    update: async () => (track('llmSettings.update'), {}),
  } as unknown as LlmSettingsService;
}

function fakeLlm(): LlmService {
  return {
    checkConnection: async () => (track('llm.checkConnection'), { ok: false, error: 'x' }),
  } as unknown as LlmService;
}

const CONFIG_DEFAULTS: Record<string, unknown> = {
  BODY_MAX_FACT: 8192,
  BODY_MAX_DOCUMENT: 262144,
  BODY_MAX_EVENT: 8192,
  TAGS_MAX: 10,
  TAG_MAX_LEN: 32,
  PUBLIC_MCP_URL: undefined,
  ACME_DOMAIN: undefined,
};

function fakeConfig(): AppConfigService {
  return { get: (key: string) => CONFIG_DEFAULTS[key] } as unknown as AppConfigService;
}

describe('dashboard-validation.http — pipe\'y wpięte w potok HTTP Nesta (tech-review #3, roadmap v1.4)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        MemoriesController,
        AuditController,
        ProposalsController,
        ProjectsController,
        AccountTokensController,
        OnboardingController,
        UsageMetricsController,
        ConfigController,
        NightlyController,
        SettingsController,
      ],
      providers: [
        { provide: MemoryAdminService, useValue: fakeMemoryAdmin() },
        { provide: PurgeService, useValue: fakePurge() },
        { provide: AuditService, useValue: fakeAudit() },
        { provide: ProposalsService, useValue: fakeProposals() },
        { provide: ProjectsService, useValue: fakeProjects() },
        { provide: UsageService, useValue: fakeUsage() },
        { provide: NightlyService, useValue: fakeNightly() },
        { provide: LlmSettingsService, useValue: fakeLlmSettings() },
        { provide: LlmService, useValue: fakeLlm() },
        { provide: OnboardingService, useValue: fakeOnboarding() },
        { provide: AppConfigService, useValue: fakeConfig() },
        DashboardErrorFilter,
      ],
    })
      .overrideGuard(SessionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(CsrfGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    calls = [];
  });

  async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, init);
    const json = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, json };
  }

  describe('400 validation_error — kształt/enum/strictness, serwis NIGDY wołany', () => {
    it('GET /api/memories?kind=bogus', async () => {
      const { status, json } = await req('GET', '/api/memories?kind=bogus');
      expect(status).toBe(400);
      expect(json).toMatchObject({ code: 'validation_error' });
      expect(json.message).toContain('kind');
      expect(calls).toEqual([]);
    });

    it('GET /api/audit?limit=abc', async () => {
      const { status, json } = await req('GET', '/api/audit?limit=abc');
      expect(status).toBe(400);
      expect(json.message).toContain('limit');
      expect(calls).toEqual([]);
    });

    it('GET /api/audit?from=wczoraj', async () => {
      const { status, json } = await req('GET', '/api/audit?from=wczoraj');
      expect(status).toBe(400);
      expect(json.message).toContain('from');
      expect(calls).toEqual([]);
    });

    it('GET /api/metrics/usage?bucket=week', async () => {
      const { status, json } = await req('GET', '/api/metrics/usage?bucket=week');
      expect(status).toBe(400);
      expect(json.message).toContain('bucket');
      expect(calls).toEqual([]);
    });

    it('GET /api/proposals?limit=501 (powyżej maksimum)', async () => {
      const { status, json } = await req('GET', '/api/proposals?limit=501');
      expect(status).toBe(400);
      expect(json).toMatchObject({ code: 'validation_error' });
      expect(json.message).toContain('limit');
      expect(calls).toEqual([]);
    });

    it('GET /api/proposals?limit=abc (niecyfrowy limit)', async () => {
      const { status, json } = await req('GET', '/api/proposals?limit=abc');
      expect(status).toBe(400);
      expect(json.message).toContain('limit');
      expect(calls).toEqual([]);
    });

    it('GET /api/proposals?cursor=garbage (nie jest kursorem keyset)', async () => {
      const { status, json } = await req('GET', '/api/proposals?cursor=garbage');
      expect(status).toBe(400);
      expect(json.message).toContain('cursor');
      expect(calls).toEqual([]);
    });

    it('GET /api/audit?cursor=<ISO> (stary format kursora) -> 400', async () => {
      const { status, json } = await req('GET', '/api/audit?cursor=2026-01-02T00%3A00%3A00.000Z');
      expect(status).toBe(400);
      expect(json.message).toContain('cursor');
      expect(calls).toEqual([]);
    });

    // Kształt zgodny z regexem, ale data kalendarzowo niepoprawna — bez walidacji Postgres rzuciłby 22008
    // na `::timestamptz` (500 zamiast 400).
    const calendarInvalidCursor = Buffer.from(
      JSON.stringify(['2026-13-45T25:61:61.000000Z', 'abc']),
    ).toString('base64url');

    it.each(['/api/audit', '/api/proposals'])(
      'GET %s?cursor=<kalendarzowo niepoprawny ts> -> 400 validation_error',
      async (path) => {
        const { status, json } = await req('GET', `${path}?cursor=${calendarInvalidCursor}`);
        expect(status).toBe(400);
        expect(json).toMatchObject({ code: 'validation_error' });
        expect(json.message).toContain('cursor');
        expect(calls).toEqual([]);
      },
    );

    it('GET /api/proposals?foo=1 (nieznany klucz query)', async () => {
      const { status, json } = await req('GET', '/api/proposals?foo=1');
      expect(status).toBe(400);
      expect(json.message).toContain('foo');
      expect(calls).toEqual([]);
    });

    it('GET /api/memories/events?limit=5 (limit nie jest wspierany na tym endpoincie -> nieznany klucz)', async () => {
      const { status, json } = await req('GET', '/api/memories/events?limit=5');
      expect(status).toBe(400);
      expect(json.message).toContain('limit');
      expect(calls).toEqual([]);
    });

    it('POST /api/memories/mem_1/relations {type:"bogus", toId:"mem_2"}', async () => {
      const { status } = await req('POST', '/api/memories/mem_1/relations', { type: 'bogus', toId: 'mem_2' });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('POST /api/proposals/bulk-approve bez body', async () => {
      const { status, json } = await req('POST', '/api/proposals/bulk-approve');
      expect(status).toBe(400);
      expect(json).toMatchObject({ code: 'validation_error' });
      expect(calls).toEqual([]);
    });

    it('PATCH /api/projects/proj_1 {includeEventsInDefaultSearch:"yes"}', async () => {
      const { status } = await req('PATCH', '/api/projects/proj_1', { includeEventsInDefaultSearch: 'yes' });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('PATCH /api/projects/proj_1 {autoModeDailyLimit: 0} (limit < 1)', async () => {
      const { status } = await req('PATCH', '/api/projects/proj_1', { autoModeDailyLimit: 0 });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it("PATCH /api/projects/proj_1 {autoMode: 'yes'} (nie-boolean)", async () => {
      const { status } = await req('PATCH', '/api/projects/proj_1', { autoMode: 'yes' });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('PATCH /api/projects/proj_1 {slug: 5} (slug nie-string)', async () => {
      const { status } = await req('PATCH', '/api/projects/proj_1', { slug: 5 });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('POST /api/projects {name:"a\tb"} (tab w nazwie — kontrakt TSV list-projects)', async () => {
      const { status, json } = await req('POST', '/api/projects', { name: 'a\tb' });
      expect(status).toBe(400);
      expect(json.message).toContain('name');
      expect(calls).toEqual([]);
    });

    it('POST /api/account-tokens/tok_1/rotate {x:1} (body bezciałowego POST wciąż strict)', async () => {
      const { status } = await req('POST', '/api/account-tokens/tok_1/rotate', { x: 1 });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('POST /api/account-tokens {label: 1} (label nie-string)', async () => {
      const { status } = await req('POST', '/api/account-tokens', { label: 1 });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('GET /api/onboarding?x=1 (endpoint bez filtrów, query wciąż strict)', async () => {
      const { status } = await req('GET', '/api/onboarding?x=1');
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('POST /api/memories {..., extra:1} (nieznany klucz body)', async () => {
      const { status } = await req('POST', '/api/memories', {
        kind: 'fact',
        header: 'H',
        body: 'B',
        scope: 'global',
        extra: 1,
      });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('GET /api/memories/bad%20id (id z nieprawidłowym formatem — spacja)', async () => {
      const { status, json } = await req('GET', '/api/memories/bad%20id');
      expect(status).toBe(400);
      expect(json.message).toContain('id');
      expect(calls).toEqual([]);
    });

    it('GET /api/config?foo=1 (endpoint bez filtrów, ale query wciąż strict — Q1)', async () => {
      const { status } = await req('GET', '/api/config?foo=1');
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('POST /api/nightly/run {x:1} (body bezciałowego POST wciąż strict — Q1)', async () => {
      const { status } = await req('POST', '/api/nightly/run', { x: 1 });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });
  });

  describe('200 — SPA-shaped requests przechodzą, dane docierają do serwisu poprawnie sparsowane', () => {
    it('GET /api/memories?scope=project&projectId=proj_1&kind=fact&tags=a&tags=b&q=x -> fake dostaje tags jako tablicę', async () => {
      let captured: unknown;
      const memoryAdmin = {
        listMemories: async (filter: unknown) => {
          captured = filter;
          return [];
        },
      } as unknown as MemoryAdminService;
      const moduleRef = await Test.createTestingModule({
        controllers: [MemoriesController],
        providers: [
          { provide: MemoryAdminService, useValue: memoryAdmin },
          { provide: PurgeService, useValue: fakePurge() },
        ],
      })
        .overrideGuard(SessionGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(CsrfGuard)
        .useValue({ canActivate: () => true })
        .compile();
      const localApp = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
      await localApp.init();
      await localApp.listen(0, '127.0.0.1');
      const address = localApp.getHttpServer().address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/memories?scope=project&projectId=proj_1&kind=fact&tags=a&tags=b&q=x`,
        );
        expect(res.status).toBe(200);
        expect(captured).toEqual({
          scope: 'project',
          projectId: 'proj_1',
          kind: 'fact',
          tags: ['a', 'b'],
          q: 'x',
        });
      } finally {
        await localApp.close();
      }
    });

    it('GET /api/memories?kind= (pusty string) -> 200, kind traktowany jako nieobecny', async () => {
      const { status } = await req('GET', '/api/memories?kind=');
      expect(status).toBe(200);
      expect(calls).toEqual(['memoryAdmin.listMemories']);
    });

    it('GET /api/audit?from=<iso>&cursor=<keyset> -> fake dostaje from jako Date, cursor jako { ts, id }', async () => {
      const pos = { ts: '2026-01-02T00:00:00.123456Z', id: 'evt_abc123' };
      const { status, json } = await req(
        'GET',
        `/api/audit?from=2026-01-01T00%3A00%3A00.000Z&cursor=${encodeKeysetCursor(pos)}`,
      );
      expect(status).toBe(200);
      expect(json).toEqual({ items: [], nextCursor: null });
      expect(calls).toEqual(['audit.query']);
      expect(lastAuditFilter).toMatchObject({ from: new Date('2026-01-01T00:00:00.000Z'), cursor: pos });
    });

    it('GET /api/proposals?limit=50&type=merge&scope=global&cursor=<keyset> -> listPendingPage dostaje sparsowane filtry', async () => {
      const pos = { ts: '2026-01-02T00:00:00.123456Z', id: 'prop_abc123' };
      const { status, json } = await req(
        'GET',
        `/api/proposals?limit=50&type=merge&scope=global&cursor=${encodeKeysetCursor(pos)}`,
      );
      expect(status).toBe(200);
      expect(json).toEqual({ items: [], nextCursor: null, total: 0 });
      expect(calls).toEqual(['proposals.listPendingPage']);
      expect(lastProposalsPageFilter).toMatchObject({ limit: 50, type: 'merge', scope: 'global', cursor: pos });
    });

    it('POST /api/proposals/p1/approve bez body -> nie 400 (domyślny status Nesta dla POST to 201)', async () => {
      const { status } = await req('POST', '/api/proposals/p1/approve');
      expect(status).not.toBe(400);
      expect(calls).toEqual(['proposals.approve']);
    });

    it('POST /api/nightly/run bez body -> nie 400 (SPA woła api.post bez drugiego argumentu)', async () => {
      const { status } = await req('POST', '/api/nightly/run');
      expect(status).not.toBe(400);
      expect(calls).toEqual(['nightly.run']);
    });

    it('PATCH /api/projects/proj_1 {slug} -> serwis dostaje slug; nie 400', async () => {
      const { status, json } = await req('PATCH', '/api/projects/proj_1', { slug: 'proj-renamed' });
      expect(status).toBe(200);
      expect(json).toMatchObject({ slug: 'proj-renamed' });
      expect(calls).toContain('projects.updateSlug:proj-renamed');
    });

    it('GET /api/onboarding -> 200, wywołuje OnboardingService.forDashboard', async () => {
      const { status } = await req('GET', '/api/onboarding');
      expect(status).toBe(200);
      expect(calls).toEqual(['onboarding.forDashboard']);
    });

    it('POST /api/account-tokens {label} -> 201, createAccountToken wywołany', async () => {
      const { status } = await req('POST', '/api/account-tokens', { label: 'laptop' });
      expect(status).toBe(201);
      expect(calls).toContain('projects.createAccountToken');
    });

    it('POST /api/memories/mem_1/archive bez body -> nie 400', async () => {
      const { status } = await req('POST', '/api/memories/mem_1/archive');
      expect(status).not.toBe(400);
      expect(calls).toEqual(['memoryAdmin.archiveMemory']);
    });
  });

  describe('PUT /api/settings/llm (roadmap v1.6) — walidacja i brak klucza API w odpowiedziach', () => {
    const VALID = {
      enabled: false,
      endpoint: null,
      model: null,
      callCap: 100,
      timeoutMs: 30000,
      scanWindowDays: 1,
      apiKey: { action: 'keep' },
    };

    it('niepoprawne body niosące klucz-wartownik -> 400, a JSON odpowiedzi NIE zawiera wartownika; serwis niewołany', async () => {
      const { status, json } = await req('PUT', '/api/settings/llm', {
        ...VALID,
        callCap: 'dużo',
        apiKey: { action: 'set', value: LLM_SENTINEL },
        nieznane: LLM_SENTINEL,
      });
      expect(status).toBe(400);
      expect(json).toMatchObject({ code: 'validation_error' });
      expect(JSON.stringify(json)).not.toContain(LLM_SENTINEL);
      expect(calls).toEqual([]);
    });

    it('endpoint z loginem/hasłem w URL-u -> 400 bez echa wartości', async () => {
      const { status, json } = await req('PUT', '/api/settings/llm', {
        ...VALID,
        endpoint: `https://user:${LLM_SENTINEL}@host/v1/chat/completions`,
      });
      expect(status).toBe(400);
      expect(JSON.stringify(json)).not.toContain(LLM_SENTINEL);
      expect(calls).toEqual([]);
    });

    it.each([
      ['cap poza zakresem', { callCap: 0 }],
      ['timeout poza zakresem', { timeoutMs: 100 }],
      ['okno poza zakresem', { scanWindowDays: 0 }],
      ['nieznana akcja klucza', { apiKey: { action: 'reveal' } }],
      ['set bez wartości', { apiKey: { action: 'set' } }],
    ])('%s -> 400', async (_label, patch) => {
      const { status } = await req('PUT', '/api/settings/llm', { ...VALID, ...patch });
      expect(status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('poprawne body przechodzi do serwisu', async () => {
      const { status } = await req('PUT', '/api/settings/llm', VALID);
      expect(status).toBe(200);
      expect(calls).toEqual(['llmSettings.update']);
    });

    it('GET i POST /check: nieznany klucz query -> 400; poprawne -> 200', async () => {
      expect((await req('GET', '/api/settings/llm?foo=1')).status).toBe(400);
      expect((await req('POST', '/api/settings/llm/check', { x: 1 })).status).toBe(400);
      expect(calls).toEqual([]);
      expect((await req('POST', '/api/settings/llm/check')).status).toBe(200);
      expect(calls).toEqual(['llm.checkConnection']);
    });
  });
});
