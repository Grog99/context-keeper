import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/common/errors';
import { UsageMetricsController } from '../src/dashboard/usage-metrics.controller';
import type { ProposalBucketRow, SearchBucketRow, UsageSeriesFilter } from '../src/usage/usage.service';
import type { UsageService } from '../src/usage/usage.service';

/** Fake `UsageService` — kontroler tylko przekazuje parsed filter i kształtuje surowe wiersze,
 * nie dotyka bazy (jak `fakeDb`/`fakeAudit` w `metrics.controller.spec.ts`). */
function fakeUsage(opts: {
  searchRows?: SearchBucketRow[];
  proposalRows?: ProposalBucketRow[];
  captureFilter?: (filter: UsageSeriesFilter) => void;
}): UsageService {
  return {
    searchSeries: async (filter: UsageSeriesFilter) => {
      opts.captureFilter?.(filter);
      return opts.searchRows ?? [];
    },
    proposalOutcomeSeries: async () => opts.proposalRows ?? [],
  } as unknown as UsageService;
}

describe('UsageMetricsController — walidacja query + kształtowanie serii (roadmap v1.1, "Pomiary")', () => {
  it('domyślny bucket to "day", domyślny zakres to ostatnie 30 dni gdy from/to pominięte', async () => {
    let captured: UsageSeriesFilter | undefined;
    const controller = new UsageMetricsController(fakeUsage({ captureFilter: (f) => (captured = f) }));

    const result = await controller.get();

    expect(result.range.bucket).toBe('day');
    expect(captured!.bucket).toBe('day');
    const spanDays = (captured!.to.getTime() - captured!.from.getTime()) / (24 * 60 * 60_000);
    expect(spanDays).toBeCloseTo(30, 1);
  });

  it('bucket spoza whitelisty ("week") rzuca ToolError(validation_error)', async () => {
    const controller = new UsageMetricsController(fakeUsage({}));
    await expect(controller.get(undefined, undefined, 'week')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('nieprawidłowa data ISO w "from" rzuca ToolError(validation_error)', async () => {
    const controller = new UsageMetricsController(fakeUsage({}));
    await expect(controller.get('nie-jest-data', undefined)).rejects.toBeInstanceOf(ToolError);
  });

  it('shapeSearchSeries: sumuje buckety per projekt, zeroResultRate liczony z sum (nie ze średniej per-bucket)', async () => {
    const rows: SearchBucketRow[] = [
      { projectId: 'proj_a', projectName: 'Alpha', ts: new Date('2026-01-01T00:00:00Z'), searches: 4, zeroResult: 1, degraded: 1 },
      { projectId: 'proj_a', projectName: 'Alpha', ts: new Date('2026-01-02T00:00:00Z'), searches: 6, zeroResult: 3, degraded: 0 },
      { projectId: 'proj_b', projectName: 'Beta', ts: new Date('2026-01-01T00:00:00Z'), searches: 2, zeroResult: 0, degraded: 0 },
    ];
    const controller = new UsageMetricsController(fakeUsage({ searchRows: rows }));

    const result = await controller.get();

    const alpha = result.searchSeries.find((s) => s.projectId === 'proj_a')!;
    expect(alpha.buckets.length).toBe(2);
    expect(alpha.totals).toEqual({ searches: 10, zeroResult: 4, degraded: 1, zeroResultRate: 0.4 });

    const beta = result.searchSeries.find((s) => s.projectId === 'proj_b')!;
    expect(beta.totals).toEqual({ searches: 2, zeroResult: 0, degraded: 0, zeroResultRate: 0 });

    // searchTotals = suma WSZYSTKICH projektów, niezależnie od per-projekt rozbicia powyżej.
    expect(result.searchTotals).toEqual({ searches: 12, zeroResult: 4, degraded: 1, zeroResultRate: 4 / 12 });
  });

  it('shapeProposalSeries: totals to suma bucketów, approvedWithEdits zostaje podzbiorem approved (bez odejmowania)', async () => {
    const rows: ProposalBucketRow[] = [
      { ts: new Date('2026-01-01T00:00:00Z'), approved: 3, rejected: 1, approvedWithEdits: 1 },
      { ts: new Date('2026-01-02T00:00:00Z'), approved: 2, rejected: 0, approvedWithEdits: 2 },
    ];
    const controller = new UsageMetricsController(fakeUsage({ proposalRows: rows }));

    const result = await controller.get();

    expect(result.proposalSeries.buckets.length).toBe(2);
    expect(result.proposalSeries.totals).toEqual({ approved: 5, rejected: 1, approvedWithEdits: 3 });
    // approvedWithEdits (3) <= approved (5) — podzbiór, nigdy nie przekracza całości.
    expect(result.proposalSeries.totals.approvedWithEdits).toBeLessThanOrEqual(result.proposalSeries.totals.approved);
  });

  it('searchTotals.zeroResultRate = 0 (nie NaN) gdy w ogóle nie było wyszukiwań', async () => {
    const controller = new UsageMetricsController(fakeUsage({ searchRows: [] }));
    const result = await controller.get();
    expect(result.searchTotals.zeroResultRate).toBe(0);
    expect(result.searchSeries).toEqual([]);
  });
});
