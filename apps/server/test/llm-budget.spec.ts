import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmRunBudget, parseLlmJson, stripCodeFence, type LlmCallRequest } from '../src/llm/llm-budget';
import {
  LlmHttpError,
  LlmNetworkError,
  LlmTimeoutError,
  type LlmProvider,
} from '../src/llm/llm-provider';
import type { LlmChatResult, LlmEndpoint } from '../src/llm/llm.types';

const ENDPOINT: LlmEndpoint = { url: 'https://llm.example/v1/chat/completions', model: 'm', apiKey: 'sk-x', timeoutMs: 1000 };
const SCHEMA = z.object({ verdict: z.enum(['keep', 'delete']) });
const OK_CONTENT = '{"verdict":"keep"}';
const AWS_SECRET = 'AKIAIOSFODNN7EXAMPLE';

type Step = LlmChatResult | Error;
function reply(content = OK_CONTENT): LlmChatResult {
  return { content, model: 'm', latencyMs: 1 };
}

/** Provider skryptowany: kolejne wywołania biorą kolejne kroki (ostatni się powtarza). */
function scripted(steps: Step[]): LlmProvider & { calls: number } {
  const p = {
    calls: 0,
    async chat(): Promise<LlmChatResult> {
      const step = steps[Math.min(p.calls, steps.length - 1)];
      p.calls++;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return p;
}

interface AuditCall {
  eventType: string;
  actor: string;
  affectedIds?: string[];
  metadata?: Record<string, unknown>;
}
function fakeAudit(opts: { failing?: boolean } = {}): { log: (i: AuditCall) => Promise<void>; calls: AuditCall[] } {
  const calls: AuditCall[] = [];
  return {
    calls,
    async log(input: AuditCall) {
      if (opts.failing) throw new Error('audit down');
      calls.push(input);
    },
  };
}

function build(
  provider: LlmProvider,
  opts: { cap?: number; audit?: ReturnType<typeof fakeAudit>; sleeps?: number[] } = {},
): LlmRunBudget {
  const sleeps = opts.sleeps ?? [];
  return LlmRunBudget.ready({
    provider,
    endpoint: ENDPOINT,
    callCap: opts.cap ?? 100,
    audit: (opts.audit ?? fakeAudit()) as never,
    actor: 'tester',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: { warn: () => undefined },
  });
}

function req(overrides: Partial<LlmCallRequest<{ verdict: 'keep' | 'delete' }>> = {}): LlmCallRequest<{ verdict: 'keep' | 'delete' }> {
  return {
    purpose: 'test',
    sources: [{ memoryId: 'mem_a', text: 'Zwykły fakt o projekcie.' }],
    messages: [{ role: 'user', content: 'Oceń fakt.' }],
    schema: SCHEMA,
    ...overrides,
  };
}

describe('LlmRunBudget — cap', () => {
  it('cap N=3, 5 wywołań -> dokładnie 3 żądania do providera, llmSkippedCap=2', async () => {
    const provider = scripted([reply()]);
    const budget = build(provider, { cap: 3 });
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await budget.call(req()));

    expect(provider.calls).toBe(3);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(3);
    expect(outcomes.slice(3)).toEqual([
      { ok: false, reason: 'cap' },
      { ok: false, reason: 'cap' },
    ]);
    expect(budget.counters()).toMatchObject({ llmCalls: 3, llmSkippedCap: 2, llmErrors: 0 });
  });

  it('współbieżność: 10 równoległych wywołań przy capie 4 -> dokładnie 4 żądania (rezerwacja synchroniczna)', async () => {
    let inFlight = 0;
    let calls = 0;
    const provider: LlmProvider = {
      async chat() {
        calls++;
        inFlight++;
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return reply();
      },
    };
    const budget = build(provider, { cap: 4 });

    const outcomes = await Promise.all(Array.from({ length: 10 }, () => budget.call(req())));

    expect(calls).toBe(4);
    expect(inFlight).toBe(0);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(4);
    expect(budget.counters()).toMatchObject({ llmCalls: 4, llmSkippedCap: 6 });
  });
});

describe('LlmRunBudget — bezpiecznik (G8)', () => {
  it('provider zawsze 500, cap 100, 10 wywołań -> 3 żądania (K=3), llmErrors=3, llmSkippedBreaker=7', async () => {
    const provider = scripted([new LlmHttpError(500, null)]);
    const budget = build(provider, { cap: 100 });
    const reasons: string[] = [];
    for (let i = 0; i < 10; i++) {
      const o = await budget.call(req());
      reasons.push(o.ok ? 'ok' : o.reason);
    }

    expect(provider.calls).toBe(3);
    expect(reasons).toEqual(['error', 'error', 'error', ...Array(7).fill('breaker')]);
    expect(budget.counters()).toMatchObject({ llmCalls: 3, llmErrors: 3, llmSkippedBreaker: 7 });
  });

  it('sukces zeruje serię błędów — 2 błędy, sukces, 2 błędy nie otwierają bezpiecznika', async () => {
    const e = new LlmHttpError(500, null);
    const provider = scripted([e, e, reply(), e, e, reply()]);
    const budget = build(provider);
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push(await budget.call(req()));

    expect(provider.calls).toBe(6);
    expect(budget.counters()).toMatchObject({ llmCalls: 6, llmErrors: 4, llmSkippedBreaker: 0 });
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
  });
});

describe('LlmRunBudget — retry 429/503 (G9)', () => {
  it('429 -> 200: 2 żądania, llmCalls=2, wynik ok, llmErrors=0', async () => {
    const provider = scripted([new LlmHttpError(429, null), reply()]);
    const sleeps: number[] = [];
    const budget = build(provider, { sleeps });

    const o = await budget.call(req());

    expect(o).toEqual({ ok: true, value: { verdict: 'keep' } });
    expect(provider.calls).toBe(2);
    expect(budget.counters()).toMatchObject({ llmCalls: 2, llmErrors: 0 });
    expect(sleeps).toEqual([1000]); // domyślny backoff gdy brak Retry-After
  });

  it('503 dwa razy -> 2 żądania, jeden błąd logiczny (llmErrors=1)', async () => {
    const provider = scripted([new LlmHttpError(503, null)]);
    const budget = build(provider);

    const o = await budget.call(req());

    expect(o).toEqual({ ok: false, reason: 'error' });
    expect(provider.calls).toBe(2);
    expect(budget.counters()).toMatchObject({ llmCalls: 2, llmErrors: 1 });
  });

  it('Retry-After 60 s -> sleep ucięty do 10 s; Retry-After 2 s -> 2 s', async () => {
    const sleeps: number[] = [];
    await build(scripted([new LlmHttpError(429, 60_000), reply()]), { sleeps }).call(req());
    await build(scripted([new LlmHttpError(429, 2_000), reply()]), { sleeps }).call(req());
    expect(sleeps).toEqual([10_000, 2_000]);
  });

  it('brak retry, gdy cap wyczerpany po pierwszej próbie (cap=1): oryginalny błąd się liczy', async () => {
    const provider = scripted([new LlmHttpError(429, null), reply()]);
    const budget = build(provider, { cap: 1 });

    const o = await budget.call(req());

    expect(o).toEqual({ ok: false, reason: 'error' });
    expect(provider.calls).toBe(1);
    expect(budget.counters()).toMatchObject({ llmCalls: 1, llmErrors: 1 });
  });

  it('timeout i błąd sieci -> 1 żądanie, bez retry, błąd policzony, bez wyjątku', async () => {
    for (const err of [new LlmTimeoutError('timeout'), new LlmNetworkError('sieć')]) {
      const provider = scripted([err, reply()]);
      const budget = build(provider);
      const o = await budget.call(req());
      expect(o).toEqual({ ok: false, reason: 'error' });
      expect(provider.calls).toBe(1);
      expect(budget.counters()).toMatchObject({ llmCalls: 1, llmErrors: 1 });
    }
  });

  it('HTTP 401/500 -> bez retry', async () => {
    for (const status of [401, 500]) {
      const provider = scripted([new LlmHttpError(status, null), reply()]);
      const o = await build(provider).call(req());
      expect(o).toEqual({ ok: false, reason: 'error' });
      expect(provider.calls).toBe(1);
    }
  });
});

describe('LlmRunBudget — walidacja odpowiedzi (G10)', () => {
  it.each([
    ['nie-JSON', 'to nie jest json'],
    ['brak pola', '{"other":1}'],
    ['zła wartość enum', '{"verdict":"maybe"}'],
  ])('%s -> {ok:false, reason:error}, policzone, bez wyjątku', async (_label, content) => {
    const provider = scripted([reply(content)]);
    const budget = build(provider);

    const o = await budget.call(req());

    expect(o).toEqual({ ok: false, reason: 'error' });
    expect(budget.counters()).toMatchObject({ llmCalls: 1, llmErrors: 1 });
  });

  it('odpowiedź w ogrodzeniu ```json … ``` jest akceptowana', async () => {
    const o = await build(scripted([reply('```json\n{"verdict":"delete"}\n```')])).call(req());
    expect(o).toEqual({ ok: true, value: { verdict: 'delete' } });
  });

  it('stripCodeFence/parseLlmJson: komunikat błędu nie cytuje treści odpowiedzi', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('  {"a":1}  ')).toBe('{"a":1}');
    const bad = parseLlmJson('SEKRET-W-ODPOWIEDZI {', SCHEMA);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('SEKRET-W-ODPOWIEDZI');
    const mismatch = parseLlmJson('{"verdict":"SEKRET-W-WARTOSCI"}', SCHEMA);
    expect(mismatch.ok).toBe(false);
    expect(JSON.stringify(mismatch)).not.toContain('SEKRET-W-WARTOSCI');
  });

  it('wyjątek w schemacie wołającego nie przecieka z call() (fail-open)', async () => {
    const exploding = { safeParse: () => { throw new Error('boom'); } } as unknown as z.ZodType<unknown>;
    const budget = build(scripted([reply()]));
    const o = await budget.call({ ...req(), schema: exploding } as never);
    expect(o).toEqual({ ok: false, reason: 'error' });
    expect(budget.counters().llmErrors).toBe(1);
  });
});

describe('LlmRunBudget — skaner sekretów (G13)', () => {
  it('treść z sekretem nie trafia do providera: 0 żądań, llmSkippedSecret=1, audyt llm_secret_skipped bez materiału', async () => {
    const provider = scripted([reply()]);
    const audit = fakeAudit();
    const budget = build(provider, { audit });

    const o = await budget.call(
      req({
        sources: [{ memoryId: 'mem_secret', text: `klucz: ${AWS_SECRET}` }],
        messages: [{ role: 'user', content: `Oceń: ${AWS_SECRET}` }],
      }),
    );

    expect(o).toEqual({ ok: false, reason: 'secret' });
    expect(provider.calls).toBe(0);
    expect(budget.counters()).toMatchObject({ llmCalls: 0, llmSkippedSecret: 1, llmErrors: 0 });
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      eventType: 'llm_secret_skipped',
      actor: 'tester',
      affectedIds: ['mem_secret'],
      metadata: { secretType: 'aws_access_key', purpose: 'test' },
    });
    expect(JSON.stringify(audit.calls)).not.toContain(AWS_SECRET);
    expect(budget.report().skippedSecret).toEqual([{ memoryId: 'mem_secret', secretType: 'aws_access_key' }]);
    expect(JSON.stringify(budget.report())).not.toContain(AWS_SECRET);
  });

  it('skan idzie przed capem i bezpiecznikiem: nie zużywa slotu; ta sama pamięć = jeden wpis audytu i listy', async () => {
    const provider = scripted([reply()]);
    const audit = fakeAudit();
    const budget = build(provider, { cap: 1, audit });
    const secretReq = req({ sources: [{ memoryId: 'mem_s', text: AWS_SECRET }] });

    await budget.call(secretReq);
    await budget.call(secretReq);
    const ok = await budget.call(req());

    expect(ok.ok).toBe(true); // slot capa nie został zużyty przez pominięcia
    expect(budget.counters()).toMatchObject({ llmCalls: 1, llmSkippedSecret: 2, llmSkippedCap: 0 });
    expect(audit.calls).toHaveLength(1);
    expect(budget.report().skippedSecret).toHaveLength(1);
  });

  it('backstop: sekret tylko w złożonej treści wiadomości -> wywołanie pominięte, przypisane źródłom', async () => {
    const provider = scripted([reply()]);
    const audit = fakeAudit();
    const budget = build(provider, { audit });

    const o = await budget.call(
      req({
        sources: [{ memoryId: 'mem_clean', text: 'czysty tekst' }],
        messages: [{ role: 'system', content: `instrukcja z ${AWS_SECRET}` }],
      }),
    );

    expect(o).toEqual({ ok: false, reason: 'secret' });
    expect(provider.calls).toBe(0);
    expect(audit.calls[0]).toMatchObject({ affectedIds: ['mem_clean'] });
  });

  it('awaria zapisu audytu nie wywraca call(): wpis i tak pominięty i policzony', async () => {
    const provider = scripted([reply()]);
    const budget = build(provider, { audit: fakeAudit({ failing: true }) });

    const o = await budget.call(req({ sources: [{ memoryId: 'mem_s', text: AWS_SECRET }] }));

    expect(o).toEqual({ ok: false, reason: 'secret' });
    expect(provider.calls).toBe(0);
    expect(budget.counters().llmSkippedSecret).toBe(1);
  });
});

describe('LlmRunBudget — stany disabled / unavailable / key_unreadable', () => {
  it('disabled i unavailable: żadnych liczników, żadnego wywołania, enabled=false', async () => {
    for (const budget of [LlmRunBudget.disabled(), LlmRunBudget.unavailable()]) {
      expect(budget.enabled).toBe(false);
      const o = await budget.call(req());
      expect(o).toEqual({ ok: false, reason: 'disabled' });
      expect(budget.counters()).toEqual({
        llmCalls: 0,
        llmErrors: 0,
        llmSkippedCap: 0,
        llmSkippedBreaker: 0,
        llmSkippedSecret: 0,
        llmSkippedKeyUnreadable: 0,
      });
    }
    expect(LlmRunBudget.unavailable().report()).toEqual({ state: 'unavailable', skippedSecret: [] });
  });

  it('key_unreadable: brak wywołania, llmSkippedKeyUnreadable rośnie per call()', async () => {
    const budget = LlmRunBudget.keyUnreadable();
    expect(budget.state).toBe('key_unreadable');
    await budget.call(req());
    await budget.call(req());
    expect(budget.counters()).toMatchObject({ llmSkippedKeyUnreadable: 2, llmCalls: 0 });
    expect((await budget.call(req())).ok).toBe(false);
  });

  it('ready: enabled=true, report().state=ready', () => {
    const budget = build(scripted([reply()]));
    expect(budget.enabled).toBe(true);
    expect(budget.report()).toEqual({ state: 'ready', skippedSecret: [] });
  });
});
