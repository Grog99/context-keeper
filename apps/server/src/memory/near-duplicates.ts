import { eq } from 'drizzle-orm';
import type { Database } from '../db/db.tokens';
import { memories, type SimilarMemoryHit } from '../db/schema';
import { findAnnNeighbors } from '../embeddings/ann-search';
import { readScopeCondition } from './read-scope';

/** Ile najbliższych pamięci niesie podpowiedź (ticket near-duplicate-detection, ustalenie #9). */
export const NEAR_DUPLICATE_MAX_HITS = 3;

/** Deadline wspólnego budżetu zapisu minął, zanim kolejne zapytanie ANN wystartowało. */
export class NearDuplicateDeadlineError extends Error {
  constructor() {
    super('near-duplicate deadline exceeded');
    this.name = 'NearDuplicateDeadlineError';
  }
}

/**
 * Podpowiedź „podobne do istniejących" przy save_memory (roadmap v1.6, A1): ≤3 najbliższe
 * ZATWIERDZONE pamięci, których wektor leży w `maxDistance` (cosine `<=>`) od wektorów nowej propozycji.
 * Zwraca `[]` = „policzono, brak podobnych"; rzuca (deadline / błąd bazy) = wołający zapisuje `NULL`
 * („nie policzono") — patrz `MemoryService.detectNearDuplicates`.
 *
 * Reguły (ticket, ustalenia #5-#7, G5-G7), wszystkie przez parametry współdzielonego prymitywu
 * `findAnnNeighbors` — nie nowe ręczne zapytanie:
 * - tylko ten sam `kind` (`extraConditions`) i tylko wektory aktywnego modelu (`embeddingModel`),
 * - zasięg = projekt zapisu + `global` (`readScopeCondition('project')`) — w odróżnieniu od ŚCISŁEJ
 *   partycji nocnego dedupu (tam „scal wąsko", tu „czy czytelnik już to ma"),
 * - tylko `status='approved'` (wbudowane w prymityw) — pending proposale nie wchodzą (G6),
 * - `groupByMemory: true` dla fact i document: MIN(dist) per pamięć, dokładne (bez gubienia trafień przez
 *   filtr HNSW) i spójne z ramieniem wektorowym retrievalu; fakt ma jeden wektor, więc wynik ten sam.
 *
 * Dokument (wiele chunków, G5): jedno zapytanie na chunk nowego dokumentu, wyniki scalane do minimum
 * odległości per pamięć (jedna pozycja na pamięć), potem próg i top 3. Zapytania idą SEKWENCYJNIE, nie
 * `Promise.all` — przed każdym sprawdzamy `deadline`, więc po przekroczeniu budżetu w locie jest co
 * najwyżej jedno zapytanie (wołający `withTimeout` nie przerywa pracy już wysłanej do bazy). Bardzo
 * duży dokument może więc skończyć jako `NULL` (fail-open, zaakceptowane).
 *
 * Próg filtrujemy tutaj, nie w prymitywie (jak w nocnym jobie); `limit` per zapytanie = 3 wystarcza,
 * bo wynik jest posortowany rosnąco, więc najbliższe 3 pamięci są zawsze w top 3 każdego zapytania.
 */
export async function findNearDuplicates(p: {
  db: Database;
  queryVectors: number[][];
  embeddingModel: string;
  kind: 'fact' | 'document';
  projectId: string;
  maxDistance: number;
  deadline: number;
}): Promise<SimilarMemoryHit[]> {
  const best = new Map<string, number>(); // memoryId -> min dystans po chunkach nowej treści

  for (const queryVector of p.queryVectors) {
    if (Date.now() >= p.deadline) throw new NearDuplicateDeadlineError();

    const rows = await findAnnNeighbors({
      db: p.db,
      queryVector,
      embeddingModel: p.embeddingModel,
      scopeCondition: readScopeCondition('project', p.projectId),
      extraConditions: [eq(memories.kind, p.kind)],
      groupByMemory: true,
      limit: NEAR_DUPLICATE_MAX_HITS,
    });

    for (const row of rows) {
      const dist = Number(row.dist); // pg może zwrócić numeric jako string
      if (dist > p.maxDistance) continue;
      const prev = best.get(row.memoryId);
      if (prev === undefined || dist < prev) best.set(row.memoryId, dist);
    }
  }

  return [...best.entries()]
    .sort(([idA, distA], [idB, distB]) => distA - distB || (idA < idB ? -1 : idA > idB ? 1 : 0))
    .slice(0, NEAR_DUPLICATE_MAX_HITS)
    .map(([id, distance]) => ({ id, distance }));
}
