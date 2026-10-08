import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_ACTOR } from '../src/dashboard/dashboard.constants';
import { ProposalsController } from '../src/dashboard/proposals.controller';
import type { ProposalsService } from '../src/proposals/proposals.service';
import type {
  BulkApproveOptions,
  BulkDecisionResult,
  BulkRejectOptions,
  ListProposalsPageFilter,
  EditOptions,
  ProposalListPage,
  SwapDirectionResult,
} from '../src/proposals/proposals.types';

const RESULT: BulkDecisionResult = { succeeded: ['prop_1', 'prop_2'], failed: [] };

/** Fake `ProposalsService` — `ProposalsController` jest cienkim wrapperem nad `bulkApprove`/
 * `bulkReject` (roadmap v1.3, "Bulk approve/reject w kolejce", §Approach planu: cała klasyfikacja
 * partial-success żyje w serwisie, nie tutaj). Test sprawdza WYŁĄCZNIE przekazywane argumenty i
 * passthrough wyniku, bez dotykania bazy — mirror `fakePurge`/`fakeMemoryAdmin`
 * (`memories.controller.spec.ts`). */
function fakeProposalsService(opts: {
  bulkApprove?: (ids: unknown, options: BulkApproveOptions) => Promise<BulkDecisionResult>;
  bulkReject?: (ids: unknown, options: BulkRejectOptions) => Promise<BulkDecisionResult>;
  listPendingPage?: (filter: ListProposalsPageFilter) => Promise<ProposalListPage>;
  swapConflictDirection?: (id: string, newTargetId: string, options: EditOptions) => Promise<SwapDirectionResult>;
}): ProposalsService {
  return {
    listPendingPage: opts.listPendingPage ?? (async () => ({ items: [], nextCursor: null, total: 0 })),
    bulkApprove: opts.bulkApprove ?? (async () => RESULT),
    bulkReject: opts.bulkReject ?? (async () => RESULT),
    swapConflictDirection:
      opts.swapConflictDirection ?? (async (_id, memoryId) => ({ memoryId, counterpartId: 'mem_other' })),
  } as unknown as ProposalsService;
}

describe('ProposalsController — bulk approve/reject (roadmap v1.3, "Bulk approve/reject w kolejce")', () => {
  it('POST bulk-approve przekazuje body.ids i {actor: DASHBOARD_ACTOR} do ProposalsService.bulkApprove, zwraca wynik bez transformacji', async () => {
    let captured: { ids: unknown; options: BulkApproveOptions } | undefined;
    const controller = new ProposalsController(
      fakeProposalsService({
        bulkApprove: async (ids, options) => {
          captured = { ids, options };
          return RESULT;
        },
      }),
    );

    const result = await controller.bulkApprove({ ids: ['prop_1', 'prop_2'] });

    expect(captured).toEqual({ ids: ['prop_1', 'prop_2'], options: { actor: DASHBOARD_ACTOR } });
    expect(result).toBe(RESULT);
  });

  // "POST bulk-approve z brakującym body" przeniesione na `dashboard-validation.http.spec.ts` —
  // od tech-review #3 (roadmap v1.4) `bulkApproveBody` wymaga `ids` na poziomie kształtu
  // (`ZodValidationPipe`), więc brakujące body jest teraz 400 `validation_error` (pipe), nie
  // `ids: undefined` przekazane dalej do `normalizeBulkIds`.

  it('POST bulk-reject przekazuje {ids, reason} + {actor: DASHBOARD_ACTOR} do ProposalsService.bulkReject', async () => {
    let captured: { ids: unknown; options: BulkRejectOptions } | undefined;
    const controller = new ProposalsController(
      fakeProposalsService({
        bulkReject: async (ids, options) => {
          captured = { ids, options };
          return RESULT;
        },
      }),
    );

    const result = await controller.bulkReject({ ids: ['prop_3'], reason: 'duplikat' });

    expect(captured).toEqual({ ids: ['prop_3'], options: { actor: DASHBOARD_ACTOR, reason: 'duplikat' } });
    expect(result).toBe(RESULT);
  });

  it('POST bulk-reject bez reason przekazuje reason=undefined (wspólny powód jest opcjonalny)', async () => {
    let captured: BulkRejectOptions | undefined;
    const controller = new ProposalsController(
      fakeProposalsService({
        bulkReject: async (_ids, options) => {
          captured = options;
          return RESULT;
        },
      }),
    );

    await controller.bulkReject({ ids: ['prop_4'] });

    expect(captured).toEqual({ actor: DASHBOARD_ACTOR, reason: undefined });
  });

  it('trasy bulk-approve/bulk-reject są POST na literalnych segmentach (nie :id) — zadeklarowane PRZED :id trasami w kontrolerze', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ProposalsController.prototype.bulkApprove)).toBe('bulk-approve');
    expect(Reflect.getMetadata(METHOD_METADATA, ProposalsController.prototype.bulkApprove)).toBe(1); // POST

    expect(Reflect.getMetadata(PATH_METADATA, ProposalsController.prototype.bulkReject)).toBe('bulk-reject');
    expect(Reflect.getMetadata(METHOD_METADATA, ProposalsController.prototype.bulkReject)).toBe(1); // POST
  });
});

describe('ProposalsController — zamiana kierunku propozycji konfliktu (roadmap v1.6, B3, G3)', () => {
  it('POST :id/swap-direction przekazuje id, body.memoryId i {actor: DASHBOARD_ACTOR}; zwraca wynik bez transformacji', async () => {
    let captured: { id: string; target: string; options: EditOptions } | undefined;
    const out: SwapDirectionResult = { memoryId: 'mem_new', counterpartId: 'mem_old' };
    const controller = new ProposalsController(
      fakeProposalsService({
        swapConflictDirection: async (id, target, options) => {
          captured = { id, target, options };
          return out;
        },
      }),
    );

    const result = await controller.swapDirection('prop_1', { memoryId: 'mem_new' });

    expect(captured).toEqual({ id: 'prop_1', target: 'mem_new', options: { actor: DASHBOARD_ACTOR } });
    expect(result).toBe(out);
  });

  it('trasa swap-direction to POST na :id/swap-direction', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ProposalsController.prototype.swapDirection)).toBe(':id/swap-direction');
    expect(Reflect.getMetadata(METHOD_METADATA, ProposalsController.prototype.swapDirection)).toBe(1); // POST
  });
});

describe('ProposalsController — lista kolejki (nightly-scale #5)', () => {
  it('list() mapuje query na listPendingPage; scope przekazany tylko dla "global"; zwraca stronę bez transformacji', async () => {
    const page: ProposalListPage = { items: [], nextCursor: 'abc', total: 7 };
    const captured: ListProposalsPageFilter[] = [];
    const controller = new ProposalsController(
      fakeProposalsService({
        listPendingPage: async (filter) => {
          captured.push(filter);
          return page;
        },
      }),
    );
    const cursor = { ts: '2026-01-01T00:00:00.000001Z', id: 'prop_1' };

    const result = await controller.list({ type: 'merge', scope: 'global', projectId: 'proj_1', limit: 50, cursor });
    await controller.list({ scope: 'project' });
    await controller.list({ scope: 'all' });
    await controller.list({});

    expect(result).toBe(page);
    expect(captured[0]).toEqual({
      status: undefined,
      origin: undefined,
      projectId: 'proj_1',
      type: 'merge',
      scope: 'global',
      limit: 50,
      cursor,
    });
    expect(captured[1].scope).toBeUndefined();
    expect(captured[2].scope).toBeUndefined();
    expect(captured[3].scope).toBeUndefined();
  });
});
