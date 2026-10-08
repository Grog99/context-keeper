#!/usr/bin/env node
// Pomiar progu NIGHTLY_CONFLICT_DISTANCE (roadmap v1.6 B3, ticket `nightly-conflicts-report`, G2).
//
// Dla syntetycznych par faktów (fixtures/conflict-pairs.json) liczy dystans kosinusowy (`1 - cos`, ten
// sam co operator `<=>` pgvectora) przez TEN SAM tekst embeddowany co produkcja i drukuje: statystyki per
// etykieta, sweep progu 0.05 -> 0.45 (jaki odsetek pary danej etykiety mieści się w `dist <= t`) oraz
// sugerowany próg. Pasmo to dźwignia kosztu/recallu, nie precyzji: każdą parę w paśmie i tak ocenia LLM.
//
// Reguła wyboru (jak w A1): najmniejszy t, który obejmuje >= 90% par SPRZECZNYCH w tym samym języku,
// przy <= ~5% par NIEPOWIĄZANYCH w tym paśmie. Pary compatible w paśmie = oczekiwane zmarnowane wywołania.
//
// Użycie:
//   # bge-m3 przez lokalny TEI (docker run --rm -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-1.8 --model-id BAAI/bge-m3)
//   node apps/server/scripts/measure-conflict-distance.mjs --provider local --base-url http://localhost:8080
//
//   # text-embedding-3-small przez API w kształcie OpenAI (np. OpenRouter); klucz z env EMBEDDING_API_KEY
//   # albo z --env-file (czytana jest WYŁĄCZNIE linia EMBEDDING_API_KEY; klucz nigdy nie jest drukowany)
//   node apps/server/scripts/measure-conflict-distance.mjs --provider api \
//     --api-url https://openrouter.ai/api/v1/embeddings --model openai/text-embedding-3-small \
//     --env-file /path/to/.env
//
// Opcje: --pairs <json> (domyślnie fixtures/conflict-pairs.json), --dimensions 1024, --unrelated N
// (domyślnie wszystkie 42 wyprowadzone pary), --batch 16.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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
const provider = args.provider;
if (provider !== 'local' && provider !== 'api') {
  console.error('Wymagane: --provider local|api');
  process.exit(2);
}
const dimensions = Number(args.dimensions ?? 1024);
const batchSize = Number(args.batch ?? 16);
const pairsPath = typeof args.pairs === 'string' ? args.pairs : join(here, 'fixtures', 'conflict-pairs.json');

// ---- tekst embeddowany = produkcyjny `chunk()` dla faktu ------------------------------
// apps/server/src/embeddings/chunker.ts: `${header}\n\n${body}` + (tagi? `\n\nTags: ${tags.join(', ')}`).
function embeddingText({ header, body, tags }) {
  const text = `${header}\n\n${body}`;
  return tags.length > 0 ? `${text}\n\nTags: ${tags.join(', ')}` : text;
}

// ---- klucz API: env ma pierwszeństwo, potem WYŁĄCZNIE linia EMBEDDING_API_KEY z --env-file ----------

function resolveApiKey() {
  const fromEnv = process.env.EMBEDDING_API_KEY;
  if (fromEnv) return fromEnv;
  if (typeof args['env-file'] !== 'string') return undefined;
  const content = readFileSync(args['env-file'], 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*EMBEDDING_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

// ---- providery -------------------------------------------------------------------

let notices = [];

async function embedLocal(texts) {
  const baseUrl = String(args['base-url'] ?? 'http://localhost:8080').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: texts }),
  });
  if (!res.ok) throw new Error(`TEI embed http ${res.status}`);
  return await res.json();
}

function l2normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

async function embedApi(texts, apiKey) {
  const apiUrl = args['api-url'];
  const model = args.model;
  if (typeof apiUrl !== 'string' || typeof model !== 'string') {
    throw new Error('--provider api wymaga --api-url i --model');
  }
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: texts, model, dimensions }),
  });
  if (!res.ok) {
    // Tylko status i (skrócone) pole error.message z odpowiedzi — nigdy nagłówki ani klucz.
    let detail = '';
    try {
      const j = await res.json();
      const m = j?.error?.message;
      if (typeof m === 'string') detail = ` (${m.slice(0, 160)})`;
    } catch {
      /* brak JSON-a */
    }
    throw new Error(`Embedding API http ${res.status}${detail}`);
  }
  const json = await res.json();
  const data = Array.isArray(json?.data) ? [...json.data] : [];
  data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return data.map((d) => {
    const v = d.embedding;
    if (v.length === dimensions) return v;
    // OpenRouter może zignorować `dimensions` i zwrócić pełne 1536 — obcięcie do pierwszych `dimensions`
    // składowych + renormalizacja L2 to dokładnie to, co robi `dimensions`/MRL po stronie OpenAI.
    if (v.length === 1536 && dimensions < 1536) {
      if (!notices.includes('truncated')) notices.push('truncated');
      return l2normalize(v.slice(0, dimensions));
    }
    throw new Error(`Embedding API dim mismatch: oczekiwano ${dimensions} lub 1536, otrzymano ${v.length}`);
  });
}

async function embedAll(texts) {
  const unique = [...new Set(texts)];
  const apiKey = provider === 'api' ? resolveApiKey() : undefined;
  if (provider === 'api' && !apiKey) {
    throw new Error('Brak EMBEDDING_API_KEY (env albo --env-file)');
  }
  const map = new Map();
  for (let i = 0; i < unique.length; i += batchSize) {
    const chunk = unique.slice(i, i + batchSize);
    const vectors = provider === 'local' ? await embedLocal(chunk) : await embedApi(chunk, apiKey);
    if (vectors.length !== chunk.length) {
      throw new Error(`Liczba wektorów (${vectors.length}) != liczba tekstów (${chunk.length})`);
    }
    chunk.forEach((t, idx) => map.set(t, l2normalize(vectors[idx])));
  }
  return map;
}

// ---- statystyki ------------------------------------------------------------------

function cosineDistance(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  n/a');
const pct = (n, d) => (d === 0 ? '   n/a' : `${((100 * n) / d).toFixed(0).padStart(4)}%`);

function summarize(name, dists) {
  const s = [...dists].sort((a, b) => a - b);
  console.log(
    `${name.padEnd(26)} n=${String(s.length).padStart(2)}  min=${f3(s[0])}  p10=${f3(quantile(s, 0.1))}  ` +
      `p50=${f3(quantile(s, 0.5))}  p90=${f3(quantile(s, 0.9))}  max=${f3(s[s.length - 1])}`,
  );
}

// ---- main -------------------------------------------------------------------------

const fixture = JSON.parse(readFileSync(pairsPath, 'utf8'));
const pairs = fixture.pairs;

// Pary „unrelated": a z pary i × b z pary j (j = i + 13 mod n, gcd(13, n) = 1) — różne tematy,
// ale ten sam „świat" (repo deweloperskie), więc to realistyczna dolna granica, nie losowy szum.
const contradictions = pairs.filter((p) => p.label === 'contradiction');
const unrelatedCount = Math.min(Number(args.unrelated ?? contradictions.length), contradictions.length);
const derived = [];
for (let i = 0; i < unrelatedCount; i++) {
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

const modelLabel =
  provider === 'local'
    ? `local TEI @ ${args['base-url'] ?? 'http://localhost:8080'}`
    : `api ${String(args.model)} @ ${String(args['api-url'])} (dimensions=${dimensions})`;
console.log(`# Pomiar NIGHTLY_CONFLICT_DISTANCE — ${modelLabel}`);
console.log(`# pary: ${pairsPath}`);

let vectors;
try {
  vectors = await embedAll(all.flatMap((p) => [embeddingText(p.a), embeddingText(p.b)]));
} catch (err) {
  console.error(`BŁĄD: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (notices.includes('truncated')) {
  console.log(
    `# UWAGA: API zwróciło wektory 1536 wym. (parametr dimensions zignorowany) — obcięto do ${dimensions} i ` +
      'znormalizowano L2 (równoważne dimensions/MRL OpenAI).',
  );
} else if (provider === 'api') {
  console.log(`# API uwzględniło parametr dimensions (wektory ${dimensions} wym. bez obcinania po stronie skryptu).`);
}

const rows = all.map((p) => ({
  ...p,
  dist: cosineDistance(vectors.get(embeddingText(p.a)), vectors.get(embeddingText(p.b))),
}));

const group = (pred) => rows.filter(pred);
const groups = {
  'contradiction (same lang)': group((r) => r.label === 'contradiction' && r.lang !== 'pl-en'),
  'contradiction (EN<->PL)': group((r) => r.label === 'contradiction' && r.lang === 'pl-en'),
  compatible: group((r) => r.label === 'compatible'),
  'paraphrase (same lang)': group((r) => r.label === 'paraphrase' && r.lang !== 'pl-en'),
  'paraphrase (EN<->PL)': group((r) => r.label === 'paraphrase' && r.lang === 'pl-en'),
  unrelated: group((r) => r.label === 'unrelated'),
};

console.log('\n## Statystyki dystansu (cosine distance)');
for (const [name, rs] of Object.entries(groups)) summarize(name, rs.map((r) => r.dist));

console.log('\n## Sweep progu: odsetek par danej etykiety z dist <= t');
const cols = Object.keys(groups);
const short = ['contra', 'contraX', 'compat', 'parafr', 'parafrX', 'unrel'];
console.log(`t     ${short.map((s) => s.padStart(8)).join(' ')}`);
const sweep = [];
for (let k = 5; k <= 45; k++) {
  const t = k / 100;
  const shares = cols.map((c) => groups[c].filter((r) => r.dist <= t).length);
  sweep.push({ t, counts: shares });
  console.log(`${t.toFixed(2)}  ${shares.map((n, i) => pct(n, groups[cols[i]].length).padStart(8)).join(' ')}`);
}

// Sugerowany próg wg reguły z nagłówka.
const sameLang = groups['contradiction (same lang)'];
const unrel = groups.unrelated;
const covers = (t) => sameLang.filter((r) => r.dist <= t).length / sameLang.length;
const unrelShare = (t) => unrel.filter((r) => r.dist <= t).length / unrel.length;
const ok = sweep.find(({ t }) => covers(t) >= 0.9 && unrelShare(t) <= 0.05);
const coverOnly = sweep.find(({ t }) => covers(t) >= 0.9);
console.log('\n## Sugerowany próg');
if (ok) {
  console.log(
    `t = ${ok.t.toFixed(2)} (pokrycie sprzeczności same-lang ${(100 * covers(ok.t)).toFixed(0)}%, ` +
      `niepowiązane w paśmie ${(100 * unrelShare(ok.t)).toFixed(0)}%, ` +
      `compatible w paśmie ${groups.compatible.filter((r) => r.dist <= ok.t).length}/${groups.compatible.length} = oczekiwane zmarnowane wywołania)`,
  );
} else if (coverOnly) {
  console.log(
    `Brak t spełniającego oba warunki. Najmniejsze t z pokryciem >= 90%: ${coverOnly.t.toFixed(2)} ` +
      `(niepowiązane w paśmie ${(100 * unrelShare(coverOnly.t)).toFixed(0)}% > 5%) — to kompromis do ręcznej decyzji.`,
  );
} else {
  console.log('Brak t <= 0.45 z pokryciem >= 90% sprzeczności same-lang — sprawdź model/dane.');
}
const crossLang = groups['contradiction (EN<->PL)'];
if (crossLang.length > 0 && ok) {
  console.log(
    `Pary międzyjęzykowe (EN<->PL) w tym paśmie: ${crossLang.filter((r) => r.dist <= ok.t).length}/${crossLang.length} ` +
      '(poza zasięgiem, jeśli model słabo łączy języki — ograniczenie modelu, jak w A1).',
  );
}

console.log('\n## Najdalsze sprzeczności same-lang (ogon decyzji o progu)');
for (const r of [...sameLang].sort((a, b) => b.dist - a.dist).slice(0, 5)) {
  console.log(`${r.id}  dist=${f3(r.dist)}  "${r.a.header}"  vs  "${r.b.header}"`);
}
console.log('\n## Najbliższe niepowiązane (dolna granica szumu)');
for (const r of [...unrel].sort((a, b) => a.dist - b.dist).slice(0, 5)) {
  console.log(`${r.id}  dist=${f3(r.dist)}  "${r.a.header}"  vs  "${r.b.header}"`);
}
