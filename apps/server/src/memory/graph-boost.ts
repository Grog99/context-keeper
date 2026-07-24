/**
 * 1-hop graph boost (roadmap v1.2, "memory-relations + 1-hop graph boost") — trzeci multiplikatywny
 * faktor post-RRF w `MemoryService.search()`, obok `decayFactor` (§memory/decay.ts):
 * `effectiveScore = rrfScore * decayFactor * graphBoostFactor(...)`. Czysta funkcja — bez DB/IO,
 * bezpośrednio testowalna (jak `rrf.ts`/`decay.ts`).
 *
 * RE-RANK ONLY (locked decision planu): nigdy nie wstrzykuje pamięci, których search nie zwrócił —
 * `selectBoostedIds` przyjmuje krawędzie WYŁĄCZNIE między id-kami już obecnymi w sfuzjowanym
 * kandydackim zbiorze (`fetchInSetEdges` w `memory.service.ts` filtruje to na poziomie zapytania SQL,
 * `WHERE from IN (ids) AND to IN (ids)` — tu dodatkowo egzekwowane defensywnie na wypadek wywołania
 * spoza tamtego kontekstu).
 *
 * Symetryczny, jednoskokowy, BINARNY (bez degree-scalingu w v1 — Stage-2 answer #2): id ma boost
 * gdy uczestniczy w PRZYNAJMNIEJ JEDNEJ krawędzi, której DRUGI koniec też jest w zbiorze kandydatów —
 * kierunek krawędzi (`from`/`to`) jest metadaną dla człowieka, nie wpływa na to czy boost się nalicza.
 * Self-loop (from===to) jest ignorowany defensywnie (schema ma już `CHECK` blokujący insert, ale
 * funkcja czysta nie polega na tym z zewnątrz).
 */
export interface RelationEdge {
  fromMemoryId: string;
  toMemoryId: string;
}

/** Zbiór id-ów kandydackich, które mają co najmniej jedną krawędź do INNEGO id-u w tym samym zbiorze. */
export function selectBoostedIds(candidateIds: string[], edges: RelationEdge[]): Set<string> {
  const candidates = new Set(candidateIds);
  const boosted = new Set<string>();
  for (const edge of edges) {
    if (edge.fromMemoryId === edge.toMemoryId) continue; // self-loop — ignorowany defensywnie
    if (!candidates.has(edge.fromMemoryId) || !candidates.has(edge.toMemoryId)) continue; // re-rank only
    boosted.add(edge.fromMemoryId);
    boosted.add(edge.toMemoryId);
  }
  return boosted;
}

/**
 * Faktor multiplikatywny — `1` (no-op) gdy `isBoosted=false` LUB `weight<=0`, inaczej `1+weight`.
 * Bounded z góry przez `1+weight` (jednorazowo — binarny, nie kumuluje się po liczbie sąsiadów).
 */
export function graphBoostFactor(isBoosted: boolean, weight: number): number {
  if (!isBoosted || weight <= 0) return 1;
  return 1 + weight;
}
