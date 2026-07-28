import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_ACTOR } from '../src/dashboard/dashboard.constants';
import { ProposalsController } from '../src/dashboard/proposals.controller';
import type { ProposalsService } from '../src/proposals/proposals.service';
import type { BulkApproveOptions, BulkDecisionResult, BulkRejectOptions } from '../src/proposals/proposals.types';

const RESULT: BulkDecisionResult = { succeeded: ['prop_1', 'prop_2'], failed: [] };

/** Fake `ProposalsService` — `ProposalsController` jest cienkim wrapperem nad `bulkApprove`/
 * `bulkReject` (roadmap v1.3, "Bulk approve/reject w kolejce", §Approach planu: cała klasyfikacja
 * partial-success żyje w serwisie, nie tutaj). Test sprawdza WYŁĄCZNIE przekazywane argumenty i
 * passthrough wyniku, bez dotykania bazy — mirror `fakePurge`/`fakeMemoryAdmin`
 * (`memories.controller.spec.ts`). */
function fakeProposalsService(opts: {
  bulkApprove?: (ids: unknown, options: BulkApproveOptions) => Promise<BulkDecisionResult>;
  bulkReject?: (ids: unknown, options: BulkRejectOptions) => Promise<BulkDecisionResult>;
}): ProposalsService {
  return {
    bulkApprove: opts.bulkApprove ?? (async () => RESULT),
    bulkReject: opts.bulkReject ?? (async () => RESULT),
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

  it('POST bulk-approve z brakującym body przekazuje ids=undefined (walidację koperty robi ProposalsService.normalizeBulkIds)', async () => {
    let captured: unknown;
    const controller = new ProposalsController(
      fakeProposalsService({
        bulkApprove: async (ids) => {
          captured = ids;
          return RESULT;
        },
      }),
    );

    await controller.bulkApprove(undefined as unknown as { ids: string[] });

    expect(captured).toBeUndefined();
  });

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
