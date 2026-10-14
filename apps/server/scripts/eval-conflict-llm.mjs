#!/usr/bin/env node
// Porównanie modeli czatowych dla detektora sprzeczności nocnego joba (roadmap v1.6 B3, `llm-conflicts.ts`).
//
// Dla syntetycznych par faktów (fixtures/conflict-pairs.json + pary „unrelated" wyprowadzone jak w
// measure-conflict-distance.mjs) woła każdy model TYM SAMYM promptem, wiadomościami i schematem werdyktu co
// produkcja — importowanymi ze zbudowanego `dist/` (najpierw `pnpm --filter @context-keeper/server build`
// albo `npx nest build` w apps/server) — i TYM SAMYM kształtem żądania co `OpenAiChatProvider`:
// `{model, messages, response_format: json_object}`, bez temperature/max_tokens/reasoning. Retry raz na
// 429/503 (jak `LlmRunBudget`), timeout bez retry.
//
// Drukuje tabelę: precision/recall/F1 (pozytyw = contradiction; negatywy = compatible, paraphrase,
// unrelated), recall per język, błędy odpowiedzi, stabilność werdyktu między powtórzeniami, latencję p50/p95,
// koszt (tokeny z `usage` × cennik z /api/v1/models) i zgodność `reason` (długość, język). Precision jest
// priorytetem: false positive = propozycja archiwizacji poprawnego faktu w kolejce akceptacji.
//
// Użycie (OpenRouter; klucz z env OPENROUTER_API_KEY albo z --env-file — czytana jest WYŁĄCZNIE linia
// --env-key, domyślnie OPENROUTER_API_KEY; klucz nigdy nie jest drukowany):
//   node apps/server/scripts/eval-conflict-llm.mjs --models anthropic/claude-haiku-5.5,openai/gpt-6-luna \
//     --env-file .env --env-key EMBEDDING_API_KEY --out /tmp/eval.json
//
// Opcje: --url (domyślnie https://openrouter.ai/api/v1/chat/completions), --repeats 3, --unrelated 20,
// --concurrency 4 (per model; modele lecą równolegle), --timeout 30000, --pairs <json>, --out <json>
// (surowe wyniki per wywołanie, z uzasadnieniami — do przeglądu FP/FN).

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let conflicts;
let budget;
try {
  conflicts = require(join(here, '..', 'dist', 'nightly', 'llm-conflicts.js'));
  budget = require(join(here, '..', 'dist', 'llm', 'llm-budget.js'));
} catch {
  console.error(
    'Brak apps/server/dist — zbuduj serwer (npx nest build w apps/server) i uruchom ponownie.',
  );
  process.exit(2);
}

// ---- argumenty -----------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Nieznany argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (typeof args.models !== 'string') {
  console.error('Wymagane: --models <id>[,<id>…]');
  process.exit(2);
}
const models = args.models
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const url =
  typeof args.url === 'string' ? args.url : 'https://openrouter.ai/api/v1/chat/completions';
const repeats = Number(args.repeats ?? 3);
const unrelatedCount = Number(args.unrelated ?? 20);
const concurrency = Number(args.concurrency ?? 4);
const timeoutMs = Number(args.timeout ?? 30_000);
const pairsPath =
  typeof args.pairs === 'string' ? args.pairs : join(here, 'fixtures', 'conflict-pairs.json');

function readKey() {
  const envKey = typeof args['env-key'] === 'string' ? args['env-key'] : 'OPENROUTER_API_KEY';
  if (typeof args['env-file'] === 'string') {
    const line = readFileSync(args['env-file'], 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${envKey}=`));
    const value = line
      ?.slice(envKey.length + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (value) return value;
  }
  return process.env.OPENROUTER_API_KEY || null;
}
const apiKey = readKey();
if (!apiKey) {
  console.error('Brak klucza API: ustaw OPENROUTER_API_KEY albo podaj --env-file (i --env-key).');
  process.exit(2);
}

// ---- dane ----------------------------------------------------------------------

const fixture = JSON.parse(readFileSync(pairsPath, 'utf8'));
const pairs = fixture.pairs;
const contradictions = pairs.filter((p) => p.label === 'contradiction');
const derived = [];
for (let i = 0; i < Math.min(unrelatedCount, contradictions.length); i++) {
  const j = (i + 13) % contradictions.length;
  derived.push({
    id: `u${String(i + 1).padStart(2, '0')}`,
    label: 'unrelated',
    lang: contradictions[i].lang === contradictions[j].lang ? contradictions[i].lang : 'pl-en',
    a: contradictions[i].a,
    b: contradictions[j].b,
  });
}
const all = [...pairs, ...derived];

const createdAt = new Date('2026-01-01T00:00:00Z');
function toFact(pairId, side, f) {
  return {
    id: `${pairId}-${side}`,
    version: 1,
    scope: 'project',
    projectId: 'eval',
    ...f,
    createdAt,
  };
}
const systemPrompt = conflicts.buildConflictSystemPrompt();
const schema = conflicts.buildConflictVerdictSchema();
const prepared = all.map((p) => {
  // Remis createdAt -> starszy = mniejsze id (`-a`); buildConflictMessages i tak sortuje po id.
  const pair = { older: toFact(p.id, 'a', p.a), newer: toFact(p.id, 'b', p.b), dist: 0 };
  return { ...p, messages: conflicts.buildConflictMessages(pair, systemPrompt) };
});

// ---- wywołanie (kształt OpenAiChatProvider + retry LlmRunBudget) -------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chatOnce(model, messages) {
  const started = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after'));
    return {
      httpStatus: res.status,
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
    };
  }
  const json = await res.json();
  const latencyMs = Math.round(performance.now() - started);
  if (json?.error) return { httpStatus: json.error.code ?? 'error-in-body', latencyMs };
  return {
    content: json?.choices?.[0]?.message?.content,
    usage: json?.usage ?? null,
    servedModel: json?.model ?? null,
    provider: json?.provider ?? null,
    latencyMs,
  };
}

async function call(model, messages) {
  try {
    let r = await chatOnce(model, messages);
    if (r.httpStatus === 429 || r.httpStatus === 503) {
      await sleep(Math.min(r.retryAfterMs ?? 1000, 10_000));
      r = await chatOnce(model, messages);
    }
    if (r.httpStatus !== undefined) return { ok: false, error: `HTTP ${r.httpStatus}` };
    if (typeof r.content !== 'string') return { ok: false, error: 'brak content', ...r };
    const parsed = budget.parseLlmJson(r.content, schema);
    if (!parsed.ok) return { ok: false, error: parsed.reason, raw: r.content, ...r };
    return { ok: true, verdict: parsed.value, ...r };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return {
      ok: false,
      error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    };
  }
}

async function runModel(model) {
  const tasks = [];
  for (let r = 0; r < repeats; r++) for (const p of prepared) tasks.push({ p, r });
  const results = [];
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const { p, r } = tasks[next++];
      const out = await call(model, p.messages);
      results.push({
        model,
        pairId: p.id,
        label: p.label,
        category: p.category,
        lang: p.lang,
        repeat: r,
        ...out,
      });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write(`  ✓ ${model} (${results.length} wywołań)\n`);
  return results;
}

// ---- cennik ----------------------------------------------------------------------

let pricing = new Map();
try {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  const { data } = await res.json();
  pricing = new Map(
    data.map((m) => [m.id, { in: Number(m.pricing.prompt), out: Number(m.pricing.completion) }]),
  );
} catch {
  console.error('# UWAGA: nie udało się pobrać cennika OpenRouter — koszt pominięty.');
}

// ---- przebieg ----------------------------------------------------------------------

console.log(
  `# Eval detektora sprzeczności — ${all.length} par (${pairs.length} z fixture + ${derived.length} unrelated) × ${repeats} powtórzeń`,
);
console.log(`# endpoint: ${url}, concurrency ${concurrency}/model, timeout ${timeoutMs} ms`);
process.stderr.write(`Uruchamiam ${models.length} modeli…\n`);
const perModel = await Promise.all(models.map(runModel));

// ---- metryki -----------------------------------------------------------------------

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);
const quantile = (xs, q) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
// Heurystyka „uzasadnienie po polsku": polskie znaki albo krótkie słowa, które w angielskim prawie nie stoją same.
const PL_HINT =
  /[ąćęłńóśźż]|\b(w|na|z|jest|nie|oraz|się|wpis|podaje|twierdzi|natomiast|zmienia|usuwa)\b/i;

const summary = [];
for (const results of perModel) {
  const model = results[0]?.model;
  const ok = results.filter((r) => r.ok);
  const isPos = (r) => r.label === 'contradiction';
  const tp = ok.filter((r) => isPos(r) && r.verdict.contradiction).length;
  const fn = ok.filter((r) => isPos(r) && !r.verdict.contradiction).length;
  const fp = ok.filter((r) => !isPos(r) && r.verdict.contradiction).length;
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null;

  const recallByLang = {};
  for (const lang of ['pl', 'en', 'pl-en']) {
    const pos = ok.filter((r) => isPos(r) && r.lang === lang);
    recallByLang[lang] = pct(pos.filter((r) => r.verdict.contradiction).length, pos.length);
  }
  const fpByLabel = {};
  for (const label of ['compatible', 'paraphrase', 'unrelated']) {
    const neg = ok.filter((r) => r.label === label);
    fpByLabel[label] = `${neg.filter((r) => r.verdict.contradiction).length}/${neg.length}`;
  }

  // Stabilność: odsetek par, dla których wszystkie udane powtórzenia dały ten sam werdykt.
  const byPair = new Map();
  for (const r of ok) {
    if (!byPair.has(r.pairId)) byPair.set(r.pairId, []);
    byPair.get(r.pairId).push(r.verdict.contradiction);
  }
  const multi = [...byPair.values()].filter((v) => v.length >= 2);
  const stable = multi.filter((v) => v.every((x) => x === v[0])).length;

  const latencies = ok.map((r) => r.latencyMs);
  const errors = results.filter((r) => !r.ok);
  const errorKinds = {};
  for (const e of errors) errorKinds[e.error] = (errorKinds[e.error] ?? 0) + 1;

  const price = pricing.get(model);
  const tokIn = ok.reduce((s, r) => s + (r.usage?.prompt_tokens ?? 0), 0);
  const tokOut = ok.reduce((s, r) => s + (r.usage?.completion_tokens ?? 0), 0);
  const tokReasoning = ok.reduce(
    (s, r) => s + (r.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
    0,
  );
  const costPer100 =
    price && ok.length > 0 ? ((tokIn * price.in + tokOut * price.out) / ok.length) * 100 : null;

  // Trafność per kategoria (fixture z polem `category`, np. conflict-pairs-hard.json).
  const byCategory = {};
  for (const r of ok) {
    if (!r.category) continue;
    const c = (byCategory[r.category] ??= { label: r.label, correct: 0, total: 0 });
    c.total++;
    if (r.verdict.contradiction === isPos(r)) c.correct++;
  }

  const withReason = ok.filter((r) => r.verdict.contradiction);
  const reasonLenOk = withReason.filter((r) => r.verdict.reason.length <= 200).length;
  const langChecked = withReason.filter((r) => r.lang === 'pl' || r.lang === 'en');
  const langOk = langChecked.filter(
    (r) => (r.lang === 'pl') === PL_HINT.test(r.verdict.reason),
  ).length;

  summary.push({
    model,
    calls: results.length,
    precision,
    recall,
    f1,
    recallByLang,
    fpByLabel,
    errors: errors.length,
    errorKinds,
    stable: pct(stable, multi.length),
    p50: quantile(latencies, 0.5),
    p95: quantile(latencies, 0.95),
    avgOut: ok.length ? Math.round(tokOut / ok.length) : null,
    avgReasoning: ok.length ? Math.round(tokReasoning / ok.length) : null,
    costPer100,
    reasonLenOk: pct(reasonLenOk, withReason.length),
    reasonLangOk: pct(langOk, langChecked.length),
    byCategory,
    fpPairs: [
      ...new Set(ok.filter((r) => !isPos(r) && r.verdict.contradiction).map((r) => r.pairId)),
    ],
    fnPairs: [
      ...new Set(ok.filter((r) => isPos(r) && !r.verdict.contradiction).map((r) => r.pairId)),
    ],
  });
}

const f = (x) => (x === null ? '—' : `${(100 * x).toFixed(1)}%`);
console.log(
  '\n| model | precision | recall | F1 | recall pl / en / pl-en | FP compat / para / unrel | błędy | stabilność | p50 / p95 ms | out tok (reasoning) | $ / 100 wyw. | reason ≤200 / język |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const s of summary) {
  console.log(
    `| ${s.model} | ${f(s.precision)} | ${f(s.recall)} | ${f(s.f1)} | ${s.recallByLang.pl} / ${s.recallByLang.en} / ${s.recallByLang['pl-en']} | ` +
      `${s.fpByLabel.compatible} / ${s.fpByLabel.paraphrase} / ${s.fpByLabel.unrelated} | ${s.errors}/${s.calls} | ${s.stable} | ` +
      `${s.p50 ?? '—'} / ${s.p95 ?? '—'} | ${s.avgOut ?? '—'} (${s.avgReasoning ?? '—'}) | ` +
      `${s.costPer100 === null ? '—' : s.costPer100.toFixed(4)} | ${s.reasonLenOk} / ${s.reasonLangOk} |`,
  );
}
const categories = [...new Set(summary.flatMap((s) => Object.keys(s.byCategory)))];
if (categories.length > 0) {
  console.log(`\n| kategoria (etykieta) | ${summary.map((s) => s.model).join(' | ')} |`);
  console.log(`|---|${summary.map(() => '---').join('|')}|`);
  for (const cat of categories) {
    const label = summary.find((s) => s.byCategory[cat])?.byCategory[cat].label;
    const cells = summary.map((s) => {
      const c = s.byCategory[cat];
      return c ? `${c.correct}/${c.total}` : '—';
    });
    console.log(`| ${cat} (${label}) | ${cells.join(' | ')} |`);
  }
}

console.log('\n# Szczegóły');
for (const s of summary) {
  const kinds =
    Object.entries(s.errorKinds)
      .map(([k, v]) => `${k}×${v}`)
      .join(', ') || 'brak';
  console.log(
    `- ${s.model}: błędy: ${kinds}; FP par: ${s.fpPairs.join(', ') || '—'}; FN par: ${s.fnPairs.join(', ') || '—'}`,
  );
}

if (typeof args.out === 'string') {
  const raw = perModel.flat().map(({ messages: _m, ...r }) => r);
  writeFileSync(args.out, JSON.stringify({ summary, results: raw }, null, 2));
  console.log(`\n# surowe wyniki: ${args.out}`);
}
