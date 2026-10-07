import { describe, expect, it } from 'vitest';
import type { AuditService } from '../src/audit/audit.service';
import { DASHBOARD_ACTOR } from '../src/dashboard/dashboard.constants';
import type { LlmSettingsBody } from '../src/dashboard/dashboard.schemas';
import { SettingsController } from '../src/dashboard/settings.controller';
import type { AuditLogRow } from '../src/db/schema';
import type { LlmSettingsService } from '../src/llm/llm-settings.service';
import type { LlmService } from '../src/llm/llm.service';
import type { LlmCheckResult, LlmSettingsDto, LlmSettingsUpdate } from '../src/llm/llm.types';

const DTO: LlmSettingsDto = {
  enabled: true,
  endpoint: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-x',
  callCap: 100,
  timeoutMs: 30000,
  scanWindowDays: 1,
  apiKey: 'set',
  encryptionKeyConfigured: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function auditRow(metadata: unknown): AuditLogRow {
  return {
    id: 'evt_1',
    eventType: 'nightly_run',
    actor: 'nightly',
    affectedIds: [],
    revisionId: null,
    metadata,
    createdAt: new Date('2026-01-02T03:00:00.000Z'),
  } as AuditLogRow;
}

function build(opts: {
  lastRun?: AuditLogRow | null;
  check?: LlmCheckResult;
  onUpdate?: (input: LlmSettingsUpdate, actor: string) => void;
  onLatest?: (type: string, contains?: Record<string, unknown>) => void;
}) {
  const settings = {
    getPublic: async () => DTO,
    update: async (input: LlmSettingsUpdate, actor: string) => {
      opts.onUpdate?.(input, actor);
      return DTO;
    },
  } as unknown as LlmSettingsService;
  const llm = {
    checkConnection: async () => opts.check ?? ({ ok: true, model: 'm', latencyMs: 5, endpoint: 'e', enabled: true } as LlmCheckResult),
  } as unknown as LlmService;
  const audit = {
    latestByEventType: async (type: string, contains?: Record<string, unknown>) => {
      opts.onLatest?.(type, contains);
      return opts.lastRun ?? null;
    },
  } as unknown as AuditService;
  return new SettingsController(settings, llm, audit);
}

describe('SettingsController (roadmap v1.6) — Ustawienia / Model LLM', () => {
  it('GET: ustawienia + ostatni UDANY nightly_run (filtr status=success), liczniki i blok llm z metadanych', async () => {
    let askedType: string | undefined;
    let askedContains: Record<string, unknown> | undefined;
    const controller = build({
      lastRun: auditRow({
        status: 'success',
        counters: {
          created: 3,
          llmCalls: 7,
          llmErrors: 1,
          llmSkippedCap: 2,
          llmSkippedBreaker: 0,
          llmSkippedSecret: 1,
          llmSkippedKeyUnreadable: 0,
          llmPruneCandidates: 9,
          llmPruneKept: 5,
          llmPruneDeleteProposed: 3,
          llmPruneUpdateProposed: 1,
        },
        llm: { state: 'ready', skippedSecret: [{ memoryId: 'mem_s', secretType: 'jwt' }] },
      }),
      onLatest: (t, c) => {
        askedType = t;
        askedContains = c;
      },
    });

    const res = await controller.get();

    expect(askedType).toBe('nightly_run');
    expect(askedContains).toEqual({ status: 'success' });
    expect(res.settings).toBe(DTO);
    expect(res.lastRun).toEqual({
      at: '2026-01-02T03:00:00.000Z',
      status: 'success',
      counters: {
        llmCalls: 7,
        llmErrors: 1,
        llmSkippedCap: 2,
        llmSkippedBreaker: 0,
        llmSkippedSecret: 1,
        llmSkippedKeyUnreadable: 0,
        llmPruneCandidates: 9,
        llmPruneKept: 5,
        llmPruneDeleteProposed: 3,
        llmPruneUpdateProposed: 1,
      },
      llm: { state: 'ready', skippedSecret: [{ memoryId: 'mem_s', secretType: 'jwt' }] },
    });
  });

  it('GET: stary wiersz nightly_run (sprzed v1.6, bez pól LLM) -> liczniki 0 i llm:null', async () => {
    const res = await build({
      lastRun: auditRow({ status: 'success', counters: { created: 1, withdrawn: 0, skippedCap: 0 } }),
    }).get();

    expect(res.lastRun).toEqual({
      at: '2026-01-02T03:00:00.000Z',
      status: 'success',
      counters: {
        llmCalls: 0,
        llmErrors: 0,
        llmSkippedCap: 0,
        llmSkippedBreaker: 0,
        llmSkippedSecret: 0,
        llmSkippedKeyUnreadable: 0,
        llmPruneCandidates: 0,
        llmPruneKept: 0,
        llmPruneDeleteProposed: 0,
        llmPruneUpdateProposed: 0,
      },
      llm: null,
    });
  });

  it('GET: śmieciowe metadane nie wywracają odpowiedzi (defensywne wybieranie pól)', async () => {
    const res = await build({
      lastRun: auditRow({ counters: { llmCalls: 'dużo' }, llm: { state: 'nieznany', skippedSecret: 'x' } }),
    }).get();
    expect(res.lastRun?.counters.llmCalls).toBe(0);
    expect(res.lastRun?.llm).toBeNull();
  });

  it('GET: brak udanego przebiegu -> lastRun:null', async () => {
    expect((await build({ lastRun: null }).get()).lastRun).toBeNull();
  });

  it('PUT: przekazuje body i actor=DASHBOARD_ACTOR do serwisu, zwraca DTO', async () => {
    let got: { input: LlmSettingsUpdate; actor: string } | undefined;
    const controller = build({ onUpdate: (input, actor) => (got = { input, actor }) });
    const body: LlmSettingsBody = {
      enabled: true,
      endpoint: 'https://a/v1/chat/completions',
      model: 'm',
      callCap: 10,
      timeoutMs: 5000,
      scanWindowDays: 7,
      apiKey: { action: 'keep' },
    };

    const res = await controller.update(body);

    expect(got).toEqual({ input: body, actor: DASHBOARD_ACTOR });
    expect(res).toBe(DTO);
  });

  it('POST /check: wynik serwisu przechodzi bez transformacji — także {ok:false} jako zwykłe dane', async () => {
    const failure: LlmCheckResult = { ok: false, error: 'HTTP 401 — sprawdź klucz API.' };
    expect(await build({ check: failure }).check()).toBe(failure);
  });
});
