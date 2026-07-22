import type { PruneScore, PruneScoreInput, PruneScorer } from './nightly.types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Strategia v1 (plan §1 "Prune scoring — pluggable strategy"): recency/access, bez żadnego I/O —
 * czysta funkcja `score()`, testowalna w izolacji (`nightly-prune-scorer.spec.ts`).
 *
 * Kwalifikuje się do prune (=`delete` proposal), gdy WSZYSTKIE trzy warunki zachodzą naraz:
 *  - `age >= minAgeDays` — pamięć musi mieć szansę "dojrzeć", zanim zostanie oceniona (nie tniemy
 *    świeżo zaakceptowanych faktów, nawet jeśli nikt jeszcze po nie nie sięgnął).
 *  - `lastAccessedAt` jest `null` ALBO starsze niż `staleDays` — nigdy nieużyta, albo dawno nieużyta.
 *  - `accessCount <= maxAccessCount` — próg "prawie nieużywana" (domyślnie 0 = wyłącznie faktycznie
 *    nietknięte po zapisie; `MemoryService.get()` bumpuje ten licznik przy każdym odczycie).
 */
export class RecencyPruneScorer implements PruneScorer {
  readonly name = 'recency-v1';

  score(input: PruneScoreInput): PruneScore {
    const ageDays = (input.now.getTime() - input.createdAt.getTime()) / MS_PER_DAY;
    if (ageDays < input.thresholds.minAgeDays) {
      return { eligible: false };
    }

    const staleByAccess =
      input.lastAccessedAt === null ||
      (input.now.getTime() - input.lastAccessedAt.getTime()) / MS_PER_DAY >= input.thresholds.staleDays;
    if (!staleByAccess) {
      return { eligible: false };
    }

    if (input.accessCount > input.thresholds.maxAccessCount) {
      return { eligible: false };
    }

    return { eligible: true };
  }
}
