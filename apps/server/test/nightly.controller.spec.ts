import { describe, expect, it } from 'vitest';
import { DASHBOARD_ACTOR } from '../src/dashboard/dashboard.constants';
import { NightlyController } from '../src/dashboard/nightly.controller';
import type { NightlyService } from '../src/nightly/nightly.service';
import type { NightlyRunResult } from '../src/nightly/nightly.types';

const SUCCESS_RESULT: NightlyRunResult = {
  status: 'success',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  durationMs: 1000,
  counters: {
    created: 2,
    withdrawn: 1,
    skippedAsDup: 0,
    mergeProposed: 1,
    pruneProposed: 1,
    skippedPoliteness: 0,
    skippedCap: 0,
    searchEventsPruned: 5,
  },
};

/** Fake `NightlyService` — kontroler jest cienkim wrapperem, więc test sprawdza WYŁĄCZNIE że
 * `run()` dostaje `{ actor: DASHBOARD_ACTOR }` i że wynik wraca bez transformacji (jak
 * `usage-metrics.controller.spec.ts` faking `UsageService`). */
function fakeNightly(opts: {
  result?: NightlyRunResult;
  captureActor?: (actor: string) => void;
}): NightlyService {
  return {
    run: async ({ actor }: { actor: string }) => {
      opts.captureActor?.(actor);
      return opts.result ?? SUCCESS_RESULT;
    },
  } as unknown as NightlyService;
}

describe('NightlyController.run — ręczny trigger z dashboardu (roadmap v1.1)', () => {
  it('woła NightlyService.run() z actor=DASHBOARD_ACTOR (nie CLI "nightly"/"human-cli")', async () => {
    let capturedActor: string | undefined;
    const controller = new NightlyController(fakeNightly({ captureActor: (a) => (capturedActor = a) }));

    await controller.run();

    expect(capturedActor).toBe(DASHBOARD_ACTOR);
    expect(DASHBOARD_ACTOR).toBe('human-dashboard');
  });

  it('zwraca NightlyRunResult zwrócony przez serwis bez transformacji', async () => {
    const controller = new NightlyController(fakeNightly({ result: SUCCESS_RESULT }));

    const result = await controller.run();

    expect(result).toBe(SUCCESS_RESULT);
    expect(result.counters.searchEventsPruned).toBe(5);
  });

  it('"skipped-locked" przechodzi jako zwykłe dane 200, nie błąd', async () => {
    const skippedResult: NightlyRunResult = {
      status: 'skipped-locked',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.010Z',
      durationMs: 10,
      counters: {
        created: 0,
        withdrawn: 0,
        skippedAsDup: 0,
        mergeProposed: 0,
        pruneProposed: 0,
        skippedPoliteness: 0,
        skippedCap: 0,
        searchEventsPruned: 0,
      },
    };
    const controller = new NightlyController(fakeNightly({ result: skippedResult }));

    const result = await controller.run();

    expect(result.status).toBe('skipped-locked');
  });
});
