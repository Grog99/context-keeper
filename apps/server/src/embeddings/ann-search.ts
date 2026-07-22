import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/db.tokens';
import { embeddings, memories } from '../db/schema';
import { toPgVectorLiteral } from './embedding.service';

/** Surowy wynik jednego sąsiada ANN — `(memoryId, dystans kosinusowy)`, przed post-processingiem
 * wołającego (mapowaniem na `NeighborPair` w nightly, spłaszczeniem do samego id w `vectorArm`). */
export interface AnnNeighbor {
  memoryId: string;
  dist: number;
}

export interface AnnSearchParams {
  db: Database;
  /** Wektor query cosine ANN (`<=>`) — własny wektor faktu w nightly, query-embedding w retrieval. */
  queryVector: number[];
  embeddingModel: string;
  /** Warunek scope, budowany przez wołającego: permisywna unia `global OR project` (retrieval,
   * `MemoryService.vectorArm`) albo ścisłe dopasowanie do JEDNEGO `(scope, projectId)` bez unii
   * (nightly, `NightlyService.findNeighborPairs` — nigdy nie scala między projektami/global).
   * `undefined` dozwolone tak jak wszędzie w Drizzle `and()`/`or()` — po prostu pomijane. */
  scopeCondition: SQL | undefined;
  /** Dodatkowe predykaty specyficzne dla wołającego (retrieval: `kind`/tag filter; nightly:
   * `kind='fact'`, zawężenie do snapshotu id-ów, wykluczenie samego siebie). */
  extraConditions?: (SQL | undefined)[];
  /** `true` = kolapsuj multi-chunk dokumenty do `MIN(dist)` per `memoryId` (`vectorArm` — dokumenty
   * mają wiele chunków, FR-R3). `false` = jeden wiersz na embedding, bez agregacji (nightly — fakty
   * mają dokładnie jeden wektor aktywnego modelu). */
  groupByMemory: boolean;
  limit: number;
}

/**
 * Współdzielony niskopoziomowy prymityw ANN (pgvector cosine `<=>`, HNSW) — code review finding,
 * commit d057871 ("reuse": `NightlyService.findNeighborPairs` i `MemoryService.vectorArm`
 * hand-rollowały identyczny kształt zapytania: `toPgVectorLiteral` + wyrażenie dystansu `<=>` +
 * `innerJoin(memories)` + filtr `embeddingModel`/`status='approved'` + scope + `orderBy(dist)
 * .limit(...)`). Punkty różnicy między dwoma wołającymi (ścisłość scope, grouping, dodatkowe
 * predykaty, self-exclusion) wchodzą WYŁĄCZNIE przez parametry — helper niczego nie zgaduje o
 * intencji wołającego. Post-processing (mapowanie na `NeighborPair` + próg dystansu w nightly,
 * spłaszczenie do listy id w `vectorArm`) zostaje po stronie wołającego; ten helper zwraca surowe
 * pary `(memoryId, dist)`.
 */
export async function findAnnNeighbors(params: AnnSearchParams): Promise<AnnNeighbor[]> {
  const { db, queryVector, embeddingModel, scopeCondition, extraConditions = [], groupByMemory, limit } =
    params;

  const qvecLiteral = toPgVectorLiteral(queryVector);
  const dist = groupByMemory
    ? sql<number>`min(${embeddings.vector} <=> ${qvecLiteral}::vector)`
    : sql<number>`${embeddings.vector} <=> ${qvecLiteral}::vector`;

  const where = and(
    eq(embeddings.embeddingModel, embeddingModel),
    eq(memories.status, 'approved'),
    scopeCondition,
    ...extraConditions,
  );

  const query = db
    .select({ memoryId: embeddings.memoryId, dist })
    .from(embeddings)
    .innerJoin(memories, eq(memories.id, embeddings.memoryId))
    .where(where);

  return groupByMemory
    ? query.groupBy(embeddings.memoryId).orderBy(asc(dist)).limit(limit)
    : query.orderBy(asc(dist)).limit(limit);
}
