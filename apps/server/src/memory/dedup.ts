import type { SaveStatus } from './memory.types';

export interface DedupMatch {
  id: string;
}

export interface DedupOutcome {
  status: SaveStatus;
  /** id proposala (duplicate_pending) albo id pamięci (already_exists) — brak dla 'new'. */
  existingId?: string;
}

/**
 * Klasyfikacja dedup/idempotencji (§5 tech-stack, FR-M8) — czysta logika, oddzielona od zapytań DB
 * (`MemoryService.save` najpierw robi dwa lookupy, potem woła to). Kolejność ma znaczenie:
 * pending exact-match wygrywa przed approved exact-match (łapie retry sieciowy pierwszy).
 */
export function classifyDedup(
  pendingMatch: DedupMatch | null,
  approvedMatch: DedupMatch | null,
): DedupOutcome {
  if (pendingMatch) {
    return { status: 'duplicate_pending', existingId: pendingMatch.id };
  }
  if (approvedMatch) {
    return { status: 'already_exists', existingId: approvedMatch.id };
  }
  return { status: 'pending' };
}
