import { describe, expect, it } from 'vitest';
import { scanForSecrets } from '../src/common/secret-scanner';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import { LlmRunBudget, parseLlmJson } from '../src/llm/llm-budget';
import { LlmHttpError, type LlmProvider } from '../src/llm/llm-provider';
import { LLM_DETECTOR_CONCURRENCY, LLM_RATIONALE_REASON_MAX_LEN } from '../src/llm/llm.constants';
import type { LlmChatMessage, LlmChatResult, LlmEndpoint } from '../src/llm/llm.types';
import {
  buildPruneMessages,
  buildPruneSystemPrompt,
  buildPruneVerdictSchema,
  pruneLimitsFromConfig,
  runLlmPrune,
  verdictToCondition,
  type PruneCandidate,
  type PruneVerdict,
} from '../src/nightly/llm-prune';
import { llmWindowStart, selectWindowFacts } from '../src/nightly/llm-window';

const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
const schema = buildPruneVerdictSchema(config);
const ENDPOINT: LlmEndpoint = { url: 'http://fake.invalid/v1/chat/completions', model: 'fake', apiKey: null, timeoutMs: 1000 };
const AWS_SECRET = 'AKIAIOSFODNN7EXAMPLE';

function parse(obj: unknown) {
  return parseLlmJson(typeof obj === 'string' ? obj : JSON.stringify(obj), schema);
}

function candidate(overrides: Partial<PruneCandidate> = {}): PruneCandidate {
  return {
    id: 'mem_a',
    version: 3,
    scope: 'project',
    projectId: 'proj_x',
    header: 'Nagłówek wpisu',
    body: 'Treść wpisu.',
    tags: ['alfa', 'beta'],
    createdAt: new Date('2026-10-07T10:00:00Z'),
    ...overrides,
  };
}

describe('schemat werdyktu detektora LLM prune', () => {
  it('keep: dodatkowe pola są ignorowane', () => {
    const r = parse({ verdict: 'keep', category: 'empty', reason: 'x', header: 'h', body: 'b', tags: ['t'] });
    expect(r).toEqual({ ok: true, value: { verdict: 'keep' } });
  });

  it("keep: kategoria spoza listy (np. 'none') jest ignorowana, nie psuje parsowania", () => {
    const r = parse({ verdict: 'keep', category: 'none', reason: null });
    expect(r).toEqual({ ok: true, value: { verdict: 'keep' } });
  });

  it('keep: pola o dowolnym typie są ignorowane (category: 123, tags: "x", body: {})', () => {
    expect(parse({ verdict: 'keep', category: 123 })).toEqual({ ok: true, value: { verdict: 'keep' } });
    expect(parse({ verdict: 'keep', category: ['a'], reason: 5, header: false, body: {}, tags: 'x' })).toEqual({
      ok: true,
      value: { verdict: 'keep' },
    });
  });

  it('delete / ephemeral', () => {
    const r = parse({ verdict: 'delete', category: 'ephemeral', reason: 'Stan sesji.', header: null, body: null, tags: null });
    expect(r).toEqual({ ok: true, value: { verdict: 'delete', category: 'ephemeral', reason: 'Stan sesji.' } });
  });

  it('delete / empty', () => {
    const r = parse({ verdict: 'delete', category: 'empty', reason: 'Ogólnik.' });
    expect(r).toEqual({ ok: true, value: { verdict: 'delete', category: 'empty', reason: 'Ogólnik.' } });
  });

  it('update: samo pole header', () => {
    const r = parse({ verdict: 'update', category: 'verbose', reason: 'Przegadany.', header: 'Krótki nagłówek', body: null, tags: null });
    expect(r).toEqual({
      ok: true,
      value: { verdict: 'update', category: 'verbose', reason: 'Przegadany.', header: 'Krótki nagłówek' },
    });
  });

  it('update: body + tags, tagi są normalizowane', () => {
    const r = parse({ verdict: 'update', category: 'untidy', reason: 'Tagi.', header: null, body: '  Nowa treść.  ', tags: ['Foo ', 'bar'] });
    expect(r).toEqual({
      ok: true,
      value: { verdict: 'update', category: 'untidy', reason: 'Tagi.', body: 'Nowa treść.', tags: ['foo', 'bar'] },
    });
  });

  it('update: znak nowej linii w headerze jest zwijany', () => {
    const r = parse({ verdict: 'update', category: 'verbose', reason: 'r', header: 'Linia pierwsza\nlinia druga' });
    expect(r.ok && r.value.verdict === 'update' && r.value.header).toBe('Linia pierwsza linia druga');
  });

  it('tolerowane ogrodzenie ```json', () => {
    const r = parse('```json\n{"verdict":"keep"}\n```');
    expect(r).toEqual({ ok: true, value: { verdict: 'keep' } });
  });

  it('nieznane klucze (np. kind) są zdejmowane — model nie zmieni kind (G5)', () => {
    const r = parse({ verdict: 'update', category: 'verbose', reason: 'r', header: 'Nowy', kind: 'document', relations: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value)).not.toContain('kind');
    if (r.ok) expect(r.value).toEqual({ verdict: 'update', category: 'verbose', reason: 'r', header: 'Nowy' });
  });

  describe('odrzuca (policzony błąd, ścieżka pola w komunikacie)', () => {
    const reject = (obj: unknown, field: string) => {
      const r = parse(obj);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(field);
    };

    it('delete z kategorią verbose', () => reject({ verdict: 'delete', category: 'verbose', reason: 'r' }, 'category'));
    it('update z kategorią empty', () => reject({ verdict: 'update', category: 'empty', reason: 'r', header: 'h' }, 'category'));
    it("delete z kategorią 'none'", () => reject({ verdict: 'delete', category: 'none', reason: 'r' }, 'category'));
    it("update z kategorią 'none'", () => reject({ verdict: 'update', category: 'none', reason: 'r', header: 'h' }, 'category'));
    it('delete z kategorią nie-tekstową', () => reject({ verdict: 'delete', category: 123, reason: 'r' }, 'category'));
    it('delete bez kategorii', () => reject({ verdict: 'delete', reason: 'r' }, 'category'));
    it('delete z reason nie-tekstowym', () => reject({ verdict: 'delete', category: 'empty', reason: 5 }, 'reason'));
    it('update z tags nie-tablicą', () => reject({ verdict: 'update', category: 'untidy', reason: 'r', tags: 'x' }, 'tags'));
    it('update bez żadnego pola', () =>
      reject({ verdict: 'update', category: 'verbose', reason: 'r', header: null, body: null, tags: null }, '(root)'));
    it('body pusty', () => reject({ verdict: 'update', category: 'verbose', reason: 'r', body: '' }, 'body'));
    it('body z samych spacji', () => reject({ verdict: 'update', category: 'verbose', reason: 'r', body: '   ' }, 'body'));
    it('header 201 znaków', () => reject({ verdict: 'update', category: 'verbose', reason: 'r', header: 'x'.repeat(201) }, 'header'));
    it('tag 41 znaków', () => reject({ verdict: 'update', category: 'untidy', reason: 'r', tags: ['a'.repeat(41)] }, 'tags'));
    it('11 tagów', () =>
      reject({ verdict: 'update', category: 'untidy', reason: 'r', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, 'tags'));
    it("tag 'a b'", () => reject({ verdict: 'update', category: 'untidy', reason: 'r', tags: ['a b'] }, 'tags'));
    it('pusty reason przy delete', () => reject({ verdict: 'delete', category: 'empty', reason: '   ' }, 'reason'));
    it('sekret w body', () => reject({ verdict: 'update', category: 'verbose', reason: 'r', body: `Klucz ${AWS_SECRET} tutaj` }, 'body'));
    it('sekret w reason', () => reject({ verdict: 'delete', category: 'empty', reason: `Zawiera ${AWS_SECRET}` }, 'reason'));
    it('niepoprawny JSON', () => {
      const r = parse('{nie json');
      expect(r.ok).toBe(false);
    });
    it("verdict 'archive'", () => reject({ verdict: 'archive' }, 'verdict'));
  });

  it('komunikat odrzucenia nie cytuje treści modelu', () => {
    const r = parse({ verdict: 'update', category: 'verbose', reason: 'r', body: `Klucz ${AWS_SECRET}` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain(AWS_SECRET);
  });

  it('reason jest zwijany i przycinany do LLM_RATIONALE_REASON_MAX_LEN (…)', () => {
    const long = `${'słowo '.repeat(100)}koniec`;
    const r = parse({ verdict: 'delete', category: 'empty', reason: `  ${long}\n\n` });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.verdict === 'delete') {
      expect(r.value.reason.length).toBe(LLM_RATIONALE_REASON_MAX_LEN);
      expect(r.value.reason.endsWith('…')).toBe(true);
    }
    const spaced = parse({ verdict: 'delete', category: 'empty', reason: 'a   b\n\nc' });
    expect(spaced.ok && spaced.value.verdict === 'delete' && spaced.value.reason).toBe('a b c');
  });
});

describe('verdictToCondition', () => {
  it('keep -> null', () => {
    expect(verdictToCondition(candidate(), { verdict: 'keep' })).toBeNull();
  });

  it('delete -> dokładny warunek z rationale', () => {
    const cond = verdictToCondition(candidate(), { verdict: 'delete', category: 'ephemeral', reason: 'Stan sesji.' });
    expect(cond).toEqual({
      type: 'delete',
      detector: 'llm-prune',
      scope: 'project',
      projectId: 'proj_x',
      affectedIds: ['mem_a'],
      baseVersions: { mem_a: 3 },
      payload: { memoryId: 'mem_a', rationale: { detector: 'llm-prune', category: 'ephemeral', reason: 'Stan sesji.' } },
      conditionKey: 'delete|mem_a',
    });
  });

  it('update: patch zawiera tylko zmienione pola i nigdy kind', () => {
    const v: PruneVerdict = {
      verdict: 'update',
      category: 'verbose',
      reason: 'r',
      header: 'Nowy nagłówek',
      body: 'Treść wpisu.', // bez zmian
      tags: ['alfa', 'beta', 'gamma'],
    };
    const cond = verdictToCondition(candidate(), v);
    expect(cond?.type).toBe('update');
    expect(cond?.conditionKey).toBe('update|mem_a');
    expect(cond?.payload).toEqual({
      memoryId: 'mem_a',
      header: 'Nowy nagłówek',
      tags: ['alfa', 'beta', 'gamma'],
      rationale: { detector: 'llm-prune', category: 'verbose', reason: 'r' },
    });
    expect(Object.keys(cond?.payload ?? {})).not.toContain('kind');
  });

  it('update bez realnej zmiany (te same header/body, tagi w innej kolejności) -> null', () => {
    const v: PruneVerdict = {
      verdict: 'update',
      category: 'untidy',
      reason: 'r',
      header: 'Nagłówek wpisu',
      body: 'Treść wpisu.',
      tags: ['beta', 'alfa'],
    };
    expect(verdictToCondition(candidate(), v)).toBeNull();
  });
});

describe('okno przeglądu: llmWindowStart / selectWindowFacts', () => {
  const NOW = new Date('2026-10-07T12:00:00Z');

  it('llmWindowStart = now − N dób', () => {
    expect(llmWindowStart(NOW, 1).toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(llmWindowStart(NOW, 7).toISOString()).toBe('2026-09-30T12:00:00.000Z');
  });

  it('granica okna jest włączna, wykluczenia z każdego zbioru, kolejność createdAt ASC, id ASC', () => {
    const start = llmWindowStart(NOW, 1);
    const f = (id: string, createdAt: Date) => ({ id, createdAt });
    const facts = [
      f('mem_z_edge', start), // dokładnie na granicy -> w oknie
      f('mem_old', new Date(start.getTime() - 1)), // 1 ms przed granicą -> poza
      f('mem_b_same', new Date('2026-10-07T08:00:00Z')),
      f('mem_a_same', new Date('2026-10-07T08:00:00Z')), // remis createdAt -> id ASC
      f('mem_cluster', new Date('2026-10-07T09:00:00Z')),
      f('mem_recency', new Date('2026-10-07T09:30:00Z')),
      f('mem_pending', new Date('2026-10-07T10:00:00Z')),
      f('mem_late', new Date('2026-10-07T11:00:00Z')),
    ];
    const out = selectWindowFacts(facts, {
      windowStart: start,
      exclude: [new Set(['mem_cluster']), new Set(['mem_recency']), new Set(['mem_pending'])],
    });
    expect(out.map((x) => x.id)).toEqual(['mem_z_edge', 'mem_a_same', 'mem_b_same', 'mem_late']);
  });
});

describe('prompt', () => {
  it('instrukcja systemowa nie wygląda jak sekret (backstop LlmRunBudget)', () => {
    expect(scanForSecrets(buildPruneSystemPrompt(pruneLimitsFromConfig(config)))).toBeNull();
  });

  it('wiadomość użytkownika niesie <entry>, header, body i tagi', () => {
    const system = buildPruneSystemPrompt(pruneLimitsFromConfig(config));
    const msgs = buildPruneMessages(candidate(), system);
    expect(msgs[0]).toEqual({ role: 'system', content: system });
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe('<entry>\nheader: Nagłówek wpisu\ntags: alfa, beta\nbody:\nTreść wpisu.\n</entry>');
    expect(buildPruneMessages(candidate({ tags: [] }), system)[1].content).toContain('tags: (none)');
  });
});

describe('runLlmPrune', () => {
  interface AuditCall {
    eventType: string;
    affectedIds?: string[];
    metadata?: Record<string, unknown>;
  }

  function fakeAudit() {
    const calls: AuditCall[] = [];
    return {
      calls,
      async log(input: AuditCall) {
        calls.push(input);
      },
    };
  }

  /** Provider skryptowany po zawartości wiadomości użytkownika; śledzi współbieżność. */
  function fakeProvider(respond: (user: string) => string | Error, delayMs = 0) {
    const state = { inFlight: 0, maxInFlight: 0, users: [] as string[] };
    const provider: LlmProvider = {
      async chat(_e: LlmEndpoint, messages: LlmChatMessage[]): Promise<LlmChatResult> {
        const user = messages[messages.length - 1].content;
        state.users.push(user);
        state.inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        state.inFlight--;
        const out = respond(user);
        if (out instanceof Error) throw out;
        return { content: out, model: 'fake', latencyMs: 1 };
      },
    };
    return { provider, state };
  }

  function budgetFor(provider: LlmProvider, audit = fakeAudit(), cap = 100) {
    return LlmRunBudget.ready({
      provider,
      endpoint: ENDPOINT,
      callCap: cap,
      audit: audit as never,
      actor: 'tester',
      logger: { warn: () => undefined },
    });
  }

  const KEEP = JSON.stringify({ verdict: 'keep' });
  const DELETE = JSON.stringify({ verdict: 'delete', category: 'ephemeral', reason: 'Stan sesji.' });

  it('współbieżność nie przekracza LLM_DETECTOR_CONCURRENCY, a keep jest liczony', async () => {
    const { provider, state } = fakeProvider(() => KEEP, 5);
    const budget = budgetFor(provider);
    const candidates = Array.from({ length: 10 }, (_, i) => candidate({ id: `mem_${i}`, header: `H${i}` }));

    const result = await runLlmPrune({ budget, candidates, config });

    expect(state.maxInFlight).toBeLessThanOrEqual(LLM_DETECTOR_CONCURRENCY);
    expect(state.maxInFlight).toBe(LLM_DETECTOR_CONCURRENCY);
    expect(result.kept).toBe(10);
    expect(result.conditions).toEqual([]);
    expect(budget.counters().llmCalls).toBe(10);
  });

  it("keep z category 'none' liczy się jako kept, nie jako llmErrors", async () => {
    const { provider } = fakeProvider(() => JSON.stringify({ verdict: 'keep', category: 'none', reason: null }));
    const budget = budgetFor(provider);
    const result = await runLlmPrune({ budget, candidates: [candidate()], config });
    expect(result.kept).toBe(1);
    expect(result.conditions).toEqual([]);
    expect(budget.counters().llmErrors).toBe(0);
  });

  it('warunki wracają w kolejności kandydatów; keep nie daje warunku', async () => {
    const { provider } = fakeProvider((user) => (user.includes('header: DEL') ? DELETE : KEEP));
    const candidates = [
      candidate({ id: 'mem_1', header: 'DEL pierwszy' }),
      candidate({ id: 'mem_2', header: 'OK' }),
      candidate({ id: 'mem_3', header: 'DEL trzeci' }),
    ];
    const result = await runLlmPrune({ budget: budgetFor(provider), candidates, config });
    expect(result.conditions.map((c) => c.affectedIds[0])).toEqual(['mem_1', 'mem_3']);
    expect(result.kept).toBe(1);
  });

  it('błąd wywołania -> brak warunku, policzony llmErrors', async () => {
    const { provider } = fakeProvider(() => new LlmHttpError(500, null));
    const budget = budgetFor(provider);
    const result = await runLlmPrune({ budget, candidates: [candidate()], config });
    expect(result.conditions).toEqual([]);
    expect(result.kept).toBe(0);
    expect(budget.counters().llmErrors).toBe(1);
  });

  it('kandydat z sekretem: llmSkippedSecret, audyt z purpose=prune, provider nietknięty', async () => {
    const { provider, state } = fakeProvider(() => KEEP);
    const audit = fakeAudit();
    const budget = budgetFor(provider, audit);
    const secret = candidate({ id: 'mem_s', body: `klucz ${AWS_SECRET}` });
    const clean = candidate({ id: 'mem_ok', header: 'czysty' });

    const result = await runLlmPrune({ budget, candidates: [secret, clean], config });

    expect(budget.counters().llmSkippedSecret).toBe(1);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0].eventType).toBe('llm_secret_skipped');
    expect(audit.calls[0].affectedIds).toEqual(['mem_s']);
    expect(audit.calls[0].metadata?.purpose).toBe('prune');
    expect(state.users).toHaveLength(1);
    expect(state.users[0]).toContain('header: czysty');
    expect(result.kept).toBe(1);
  });

  it('cap=2 przy 3 kandydatach: provider widzi dwa najwcześniejsze, trzeci liczy llmSkippedCap', async () => {
    const { provider, state } = fakeProvider(() => KEEP);
    const budget = budgetFor(provider, fakeAudit(), 2);
    const base = new Date('2026-10-07T00:00:00Z').getTime();
    const sorted = selectWindowFacts(
      [
        candidate({ id: 'mem_3', header: 'Trzeci', createdAt: new Date(base + 3 * 3_600_000) }),
        candidate({ id: 'mem_1', header: 'Pierwszy', createdAt: new Date(base + 1 * 3_600_000) }),
        candidate({ id: 'mem_2', header: 'Drugi', createdAt: new Date(base + 2 * 3_600_000) }),
      ],
      { windowStart: new Date(base), exclude: [] },
    );

    await runLlmPrune({ budget, candidates: sorted, config });

    expect(state.users.map((u) => /header: (\S+)/.exec(u)?.[1]).sort()).toEqual(['Drugi', 'Pierwszy']);
    expect(budget.counters().llmCalls).toBe(2);
    expect(budget.counters().llmSkippedCap).toBe(1);
  });
});
