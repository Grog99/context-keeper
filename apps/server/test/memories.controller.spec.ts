import { describe, expect, it } from 'vitest';
import { DASHBOARD_ACTOR } from '../src/dashboard/dashboard.constants';
import { MemoriesController } from '../src/dashboard/memories.controller';
import type { MemoryAdminService } from '../src/memory/memory-admin.service';
import type { PurgeOptions, PurgePreview, PurgeResult, PurgeService } from '../src/purge/purge.service';

const PREVIEW: PurgePreview = {
  id: 'mem_1',
  status: 'approved',
  header: 'Seed header',
  embeddingsCount: 1,
  relatedProposalsCount: 2,
  revisionsWithContentCount: 3,
};

const RESULT: PurgeResult = {
  id: 'mem_1',
  embeddingsDeleted: 1,
  stagingEmbeddingsDeleted: 0,
  proposalsRedacted: 2,
  revisionsRedacted: 1,
};

/** `MemoryAdminService` nie jest wołany przez żaden test tego pliku (WYŁĄCZNIE endpointy hard-purge
 * dołożone w roadmap v1.1) — pusty stub, żeby konstruktor kontrolera się skompilował. */
function unusedMemoryAdmin(): MemoryAdminService {
  return {} as unknown as MemoryAdminService;
}

/** Fake `PurgeService` — kontroler jest cienkim wrapperem (jak `NightlyController`), test sprawdza
 * WYŁĄCZNIE przekazywane argumenty i passthrough wyniku, bez dotykania bazy. */
function fakePurge(opts: {
  preview?: PurgePreview;
  result?: PurgeResult;
  captureOptions?: (id: string, options: PurgeOptions) => void;
}): PurgeService {
  return {
    preview: async () => opts.preview ?? PREVIEW,
    purge: async (id: string, options: PurgeOptions) => {
      opts.captureOptions?.(id, options);
      return opts.result ?? RESULT;
    },
  } as unknown as PurgeService;
}

describe('MemoriesController — hard-purge endpoints (roadmap v1.1)', () => {
  it('GET :id/purge-preview zwraca PurgePreview zwrócony przez serwis bez transformacji', async () => {
    const controller = new MemoriesController(unusedMemoryAdmin(), fakePurge({ preview: PREVIEW }));

    const result = await controller.purgePreview('mem_1');

    expect(result).toBe(PREVIEW);
  });

  it('POST :id/purge przekazuje { reason, actor: DASHBOARD_ACTOR } do PurgeService.purge()', async () => {
    let captured: { id: string; options: PurgeOptions } | undefined;
    const controller = new MemoriesController(
      unusedMemoryAdmin(),
      fakePurge({
        result: RESULT,
        captureOptions: (id, options) => (captured = { id, options }),
      }),
    );

    const result = await controller.purge('mem_1', { reason: 'AWS key w body' });

    expect(captured).toEqual({
      id: 'mem_1',
      options: { reason: 'AWS key w body', actor: DASHBOARD_ACTOR },
    });
    expect(result).toBe(RESULT);
  });

  it('POST :id/purge z brakującym body traktuje reason jako pusty string (walidację robi PurgeService)', async () => {
    let captured: PurgeOptions | undefined;
    const controller = new MemoriesController(
      unusedMemoryAdmin(),
      fakePurge({ captureOptions: (_id, options) => (captured = options) }),
    );

    await controller.purge('mem_1', undefined as unknown as { reason: string });

    expect(captured).toEqual({ reason: '', actor: DASHBOARD_ACTOR });
  });
});
