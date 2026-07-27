import { generateId, ID_PREFIX } from '../common/ids';
import type { MemoryKind } from '../db/schema/enums';
import type { MergePayload } from '../proposals/proposals.types';

/** Para "near-identical" znaleziona przez ANN (dystans kosinusowy `<=>`, plan §1 "Candidate
 * detection via ANN"). Nieskierowana z natury użycia — `a`/`b` to tylko etykiety, nie kierunek. */
export interface NeighborPair {
  a: string;
  b: string;
  dist: number;
}

/** Pola faktu potrzebne do wyboru kanonicznej treści scalenia — świadomie węższe niż `MemoryRow`
 * (pure helper nie powinien znać całego schematu DB). */
export interface MergeCandidateInput {
  id: string;
  header: string;
  body: string;
  tags: string[];
  kind: MemoryKind;
  accessCount: number;
}

/**
 * Union-find (Kruskal-style, path compression) nad parami "near-identical" (plan §2
 * "dedup-cluster.ts"). Zwraca składowe spójności o rozmiarze >= 2 (pojedyncze wierzchołki bez pary
 * to nie klaster), każda posortowana rosnąco po id, całość posortowana po pierwszym elemencie —
 * deterministyczne wyjście niezależnie od kolejności/kierunku par wejściowych. Pary dwukierunkowe
 * (A-B wykryte przy skanowaniu A, B-A przy skanowaniu B — ANN nie gwarantuje symetrii) dają
 * DOKŁADNIE jeden klaster, nie dwa.
 */
export function buildClusters(pairs: NeighborPair[]): string[][] {
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    // Kompresja ścieżki — każdy odwiedzony węzeł podpięty bezpośrednio pod korzeń.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const { a, b } of pairs) {
    union(a, b);
  }

  const groups = new Map<string, Set<string>>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(id);
  }

  return Array.from(groups.values())
    .map((members) => Array.from(members).sort())
    .filter((members) => members.length >= 2)
    .sort((x, y) => x[0].localeCompare(y[0]));
}

/**
 * Zawartość wynikowej pamięci C dla jednego klastra (plan §1 "Scan broadly, merge narrowly" —
 * deterministyczne, BEZ LLM w v1). Kanoniczny członek: max `accessCount`; remis -> najdłuższy
 * `body`; kolejny remis -> najniższy `id`. Tagi = suma zbiorów wszystkich członków (deduplikowana,
 * posortowana). Deterministyczne względem KOLEJNOŚCI `members` na wejściu — ten sam klaster zawsze
 * daje identyczny payload, co jest wymogiem idempotencji re-derivacji (plan §1).
 *
 * Kind-guard (roadmap v1.3 "Dedup kind-aware", defense-in-depth): ta funkcja jest tym miejscem,
 * które faktycznie WYBIERA `kind` scalenia (`canonical.kind` niżej) — więc backstop na niezmiennik
 * "klaster nie miesza kindów" należy właśnie tu, nie tylko w partycji ANN (`findNeighborPairs`,
 * podstawowa linia obrony). Rzuca zamiast po cichu wybrać arbitralny `kind` i zgubić semantykę
 * pozostałych członków. Dziś nieosiągalne (oba końce ANN są już `kind='fact'`) — jeśli nocny skan
 * kiedyś rozszerzy się o document/event, przyszły autor decyduje: zostawić throw (wywala cały
 * przebieg przez `buildMergeCondition` → `runLocked`, jak istniejący `brak faktu ${id}`) czy
 * zdegradować do skip-and-warn.
 */
export function pickCanonicalMerge(members: MergeCandidateInput[]): MergePayload {
  if (members.length < 2) {
    throw new Error('pickCanonicalMerge wymaga klastra o rozmiarze >= 2');
  }

  const kinds = new Set(members.map((m) => m.kind));
  if (kinds.size > 1) {
    throw new Error(
      `pickCanonicalMerge: klaster miesza kind (${[...kinds].sort().join(', ')}) — ` +
        'scalenie wybrałoby jeden kind arbitralnie i zgubiło semantykę pozostałych',
    );
  }

  const canonical = [...members].sort((x, y) => {
    if (y.accessCount !== x.accessCount) return y.accessCount - x.accessCount;
    if (y.body.length !== x.body.length) return y.body.length - x.body.length;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  })[0];

  const tags = Array.from(new Set(members.flatMap((m) => m.tags))).sort();

  return {
    memoryId: generateId(ID_PREFIX.memory),
    header: canonical.header,
    body: canonical.body,
    tags,
    kind: canonical.kind,
  };
}
