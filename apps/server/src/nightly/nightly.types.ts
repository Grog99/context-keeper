import type { MemoryScope } from '../db/schema/enums';
import type { DeletePayload, MergePayload } from '../proposals/proposals.types';

/**
 * Typ warunku wykrywanego przez nocny job (plan Fazy 6 §1 "Overall shape"). Nightly jest producentem
 * WYŁĄCZNIE tych dwóch typów proposali — `create`/`update` mają innych producentów (agent-save /
 * przyszły human-edit), nigdy nocny job.
 */
export type NightlyConditionType = 'merge' | 'delete';

/**
 * Warunek wykryty w bieżącym przebiegu, PRZED reconcile (plan §2 "nightly.types.ts").
 * `affectedIds` zawsze posortowane rosnąco — determinizm i zgodność z `conditionKey`.
 */
export interface DetectedCondition {
  type: NightlyConditionType;
  scope: MemoryScope;
  projectId: string | null;
  affectedIds: string[];
  /** `{ [memoryId]: number }` — wersja `memories.version`, na podstawie której policzono warunek
   * (optimistic concurrency, tak samo jak `proposals.base_versions` gdzie indziej w kodzie). */
  baseVersions: Record<string, number>;
  payload: MergePayload | DeletePayload;
  conditionKey: string;
}

/**
 * Tożsamość warunku = `(type, sorted affectedIds)` (plan §1 "Idempotentny self-cleaning re-scan" —
 * decyzja "no new column"). Sortowanie sprawia, że kolejność wykrycia (np. inna kolejność iteracji
 * po klastrach między przebiegami) nigdy nie wpływa na dopasowanie względem proposali z poprzedniego
 * przebiegu — bez tego ten sam warunek mógłby zostać błędnie uznany za "nowy" i zdublowany.
 */
export function conditionKey(type: NightlyConditionType, affectedIds: string[]): string {
  return `${type}|${[...affectedIds].sort().join(',')}`;
}

/** Progi decyzyjne v1 (recency) — czytane z `NIGHTLY_PRUNE_*` (§5 pkt 1 planu, wartości domyślne
 * to punkt startowy, docelowo dostrajane na realnych danych, PRD §11). */
export interface PruneThresholds {
  minAgeDays: number;
  staleDays: number;
  maxAccessCount: number;
}

/** Wejście do `PruneScorer.score()` — czysty snapshot pól pamięci potrzebnych do oceny, BEZ
 * przekazywania całego wiersza DB (seam trzyma implementacje scoringu z dala od schematu). */
export interface PruneScoreInput {
  createdAt: Date;
  lastAccessedAt: Date | null;
  accessCount: number;
  now: Date;
  thresholds: PruneThresholds;
}

export interface PruneScore {
  eligible: boolean;
}

/**
 * Seam DI (plan §1 "Prune scoring — pluggable strategy"): v1 = `RecencyPruneScorer` (czysta
 * heurystyka wieku/dostępu). v2 planuje outcome-based "Memory Worth" — podmiana providera pod
 * tokenem `PRUNE_SCORER`, bez migracji schematu i bez zmian w `NightlyService`.
 */
export interface PruneScorer {
  readonly name: string;
  score(input: PruneScoreInput): PruneScore;
}

export const PRUNE_SCORER = Symbol('PRUNE_SCORER');

/**
 * Liczniki jednego przebiegu — trafiają do audytu `nightly_run` (metadata) i podsumowania CLI.
 * Pięć pierwszych pól to dosłowny kontrakt z planu §2 ("NightlyCounters"); `skippedPoliteness` i
 * `skippedCap` to jego addytywne rozszerzenie — bez nich nie dałoby się spełnić wymogu "no silent
 * truncation" z §5 pkt 5-6 planu (politeness gate i flood backstop muszą być POLICZALNE, nie tylko
 * zalogowane jednym zdaniem).
 */
export interface NightlyCounters {
  created: number;
  withdrawn: number;
  /** Wykryty warunek dopasował istniejący pending nightly proposal, wciąż aktualny — brak akcji. */
  skippedAsDup: number;
  mergeProposed: number;
  pruneProposed: number;
  /** Warunki pominięte, bo `affectedIds` nakładają się na pending proposal spoza nightly (§5 pkt 5). */
  skippedPoliteness: number;
  /** Warunki pominięte przez `NIGHTLY_MAX_PROPOSALS_PER_RUN` (§5 pkt 6) — nie zgubione, tylko
   * odłożone: wykryte ponownie przy kolejnym stateless re-scanie. */
  skippedCap: number;
  /** Wiersze `search_events` starsze niż `SEARCH_EVENTS_RETENTION_DAYS` usunięte w tym przebiegu
   * (roadmap v1.1, "Pomiary" — retencja piggyback na nocnym jobie, plan §5(b/g)). Addytywne pole,
   * jak `skippedPoliteness`/`skippedCap` powyżej — nie jest częścią oryginalnego kontraktu §2 planu
   * Fazy 6. */
  searchEventsPruned: number;
}

export interface NightlyRunResult {
  status: 'success' | 'failed' | 'skipped-locked';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  counters: NightlyCounters;
}
