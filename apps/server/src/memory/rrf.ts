export interface RrfResult {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion (§6.4 tech-stack, FR-R2): score(id) = Σ 1/(k + rank_i) po listach, gdzie
 * rank_i to 1-based pozycja id na liście i; brak na liście = brak wkładu z tej listy (nie rank=∞
 * ani domyślny 0 — po prostu pomijane w sumie). Rank-based, scale-free — cosine distance i ts_rank
 * żyją na nieporównywalnych skalach, więc fuzja przez ranking omija tuning wag per-korpus.
 * Czysta funkcja — bez DB/IO, żeby była bezpośrednio testowalna jednostkowo (memory.service.ts
 * dostarcza już posortowane listy id z każdego ramienia).
 */
export function rrfFuse(lists: string[][], k: number): RrfResult[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      const rank = i + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
