import { describe, expect, it } from 'vitest';
import { UsageMetricsController } from '../src/dashboard/usage-metrics.controller';
import type {
  AutoHoldRow,
  AutoModeFateRow,
  AutoModeMetricsFilter,
  ProposalBucketRow,
  SearchBucketRow,
  UsageSeriesFilter,
} from '../src/usage/usage.service';
import type { UsageService } from '../src/usage/usage.service';

/** Fake `UsageService` — kontroler tylko przekazuje parsed filter i kształtuje surowe wiersze,
 * nie dotyka bazy (jak `fakeDb`/`fakeAudit` w `metrics.controller.spec.ts`). */
function fakeUsage(opts: {
  searchRows?: SearchBucketRow[];
  proposalRows?: ProposalBucketRow[];
  fateRows?: AutoModeFateRow[];
  holdRows?: AutoHoldRow[];
  captureFilter?: (filter: UsageSeriesFilter) => void;
  captureAutoFilters?: (fates: AutoModeMetricsFilter, holds: AutoModeMetricsFilter) => void;
}): UsageService {
  let fatesFilter: AutoModeMetricsFilter | undefined;
  return {
    searchSeries: async (filter: UsageSeriesFilter) => {
      opts.captureFilter?.(filter);
      return opts.searchRows ?? [];
    },
    proposalOutcomeSeries: async () => opts.proposalRows ?? [],
    autoModeFates: async (filter: AutoModeMetricsFilter) => {
      fatesFilter = filter;
      return opts.fateRows ?? [];
    },
    autoHoldStats: async (filter: AutoModeMetricsFilter) => {
      opts.captureAutoFilters?.(fatesFilter!, filter);
      return opts.holdRows ?? [];
    },
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

  // "bucket spoza whitelisty" / "nieprawidłowa data ISO" przeniesione na
  // `dashboard-validation.http.spec.ts` — od tech-review #3 (roadmap v1.4) ta walidacja żyje w
  // `ZodValidationPipe` (`usageQuery`, `dashboard.schemas.ts`), nie w `parseBucket`/`parseDate`
  // inline; `controller.get(query)` teraz przyjmuje już sparsowany `UsageQuery`, więc wywołanie
  // metody BEZPOŚREDNIO (jak tutaj) omija pipe'y Nesta.

  it('shapeSearchSeries: sumuje buckety per projekt, zeroResultRate liczony z sum (nie ze średniej per-bucket)', async () => {
    const rows: SearchBucketRow[] = [
      { projectId: 'proj_a', projectName: 'Alpha', ts: new Date('2026-01-01T00:00:00Z'), searches: 4, zeroResult: 1, degraded: 1, crossProject: 0 },
      { projectId: 'proj_a', projectName: 'Alpha', ts: new Date('2026-01-02T00:00:00Z'), searches: 6, zeroResult: 3, degraded: 0, crossProject: 0 },
      { projectId: 'proj_b', projectName: 'Beta', ts: new Date('2026-01-01T00:00:00Z'), searches: 2, zeroResult: 0, degraded: 0, crossProject: 0 },
    ];
    const controller = new UsageMetricsController(fakeUsage({ searchRows: rows }));

    const result = await controller.get();

    const alpha = result.searchSeries.find((s) => s.projectId === 'proj_a')!;
    expect(alpha.buckets.length).toBe(2);
    expect(alpha.totals).toEqual({ searches: 10, zeroResult: 4, degraded: 1, crossProject: 0, zeroResultRate: 0.4 });

    const beta = result.searchSeries.find((s) => s.projectId === 'proj_b')!;
    expect(beta.totals).toEqual({ searches: 2, zeroResult: 0, degraded: 0, crossProject: 0, zeroResultRate: 0 });

    // searchTotals = suma WSZYSTKICH projektów, niezależnie od per-projekt rozbicia powyżej.
    expect(result.searchTotals).toEqual({ searches: 12, zeroResult: 4, degraded: 1, crossProject: 0, zeroResultRate: 4 / 12 });
  });

  it('wyszukiwania cross-project: wchodzą do searches i crossProject, ale wypadają z licznika I mianownika zeroResultRate (totals + trend)', async () => {
    const rows: SearchBucketRow[] = [
      // 10 wyszukiwań, z czego 6 cross; zero-result tylko wśród 4 zwykłych (cross jest wyłączony z licznika w SQL).
      { projectId: 'proj_a', projectName: 'Alpha', ts: new Date('2026-01-01T00:00:00Z'), searches: 10, zeroResult: 1, degraded: 0, crossProject: 6 },
      { projectId: 'proj_b', projectName: 'Beta', ts: new Date('2026-01-01T00:00:00Z'), searches: 5, zeroResult: 0, degraded: 0, crossProject: 5 },
    ];
    const controller = new UsageMetricsController(fakeUsage({ searchRows: rows }));

    const result = await controller.get();

    const alpha = result.searchSeries.find((s) => s.projectId === 'proj_a')!;
    expect(alpha.buckets[0]).toMatchObject({ searches: 10, crossProject: 6 });
    // 1 / (10 - 6), NIE 1 / 10.
    expect(alpha.totals).toEqual({ searches: 10, zeroResult: 1, degraded: 0, crossProject: 6, zeroResultRate: 1 / 4 });
    // Same cross -> mianownik 0 -> 0 (nie NaN/Infinity).
    const beta = result.searchSeries.find((s) => s.projectId === 'proj_b')!;
    expect(beta.totals).toEqual({ searches: 5, zeroResult: 0, degraded: 0, crossProject: 5, zeroResultRate: 0 });
    // Suma: 15 wyszukiwań, 11 cross, 1 zero-result -> 1 / 4.
    expect(result.searchTotals).toEqual({ searches: 15, zeroResult: 1, degraded: 0, crossProject: 11, zeroResultRate: 1 / 4 });
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

  describe('sekcja autoMode (roadmap v1.6, A4)', () => {
    const noReasons = { near_duplicate: 0, not_computed: 0, human_target: 0, daily_limit: 0, auto_failed: 0 };

    it('scala wiersze losu (create/update) i zawróceń per projekt; untouched = total − suma kubełków; sortuje po nazwie', async () => {
      const fateRows: AutoModeFateRow[] = [
        { projectId: 'proj_b', projectName: 'Beta', autoMode: false, type: 'create', total: 10, pruned: 1, overwritten: 2, archived: 1, undone: 3 },
        { projectId: 'proj_a', projectName: 'Alpha', autoMode: true, type: 'create', total: 4, pruned: 0, overwritten: 0, archived: 0, undone: 0 },
        { projectId: 'proj_a', projectName: 'Alpha', autoMode: true, type: 'update', total: 2, pruned: 0, overwritten: 1, archived: 0, undone: 0 },
      ];
      const holdRows: AutoHoldRow[] = [
        { projectId: 'proj_a', projectName: 'Alpha', autoMode: true, held: 3, reasons: { ...noReasons, near_duplicate: 2, daily_limit: 2 } },
      ];
      const controller = new UsageMetricsController(fakeUsage({ fateRows, holdRows }));

      const result = await controller.get();

      expect(result.autoMode.projects.map((p) => p.projectName)).toEqual(['Alpha', 'Beta']);
      const [alpha, beta] = result.autoMode.projects;
      expect(alpha).toEqual({
        projectId: 'proj_a',
        projectName: 'Alpha',
        autoModeEnabled: true,
        create: { total: 4, pruned: 0, overwritten: 0, archived: 0, undone: 0, untouched: 4 },
        update: { total: 2, pruned: 0, overwritten: 1, archived: 0, undone: 0, untouched: 1 },
        held: { total: 3, reasons: { ...noReasons, near_duplicate: 2, daily_limit: 2 } },
      });
      // Beta: wyłączony dziś, bez update i bez zawróceń → zerowane.
      expect(beta.autoModeEnabled).toBe(false);
      expect(beta.create).toEqual({ total: 10, pruned: 1, overwritten: 2, archived: 1, undone: 3, untouched: 3 });
      expect(beta.update).toEqual({ total: 0, pruned: 0, overwritten: 0, archived: 0, undone: 0, untouched: 0 });
      expect(beta.held).toEqual({ total: 0, reasons: noReasons });
    });

    it('same zawrócenia (bez auto-akceptacji) też dają wiersz projektu, z zerowanym create/update', async () => {
      const holdRows: AutoHoldRow[] = [
        { projectId: 'proj_a', projectName: 'Alpha', autoMode: true, held: 1, reasons: { ...noReasons, human_target: 1 } },
      ];
      const result = await new UsageMetricsController(fakeUsage({ holdRows })).get();
      expect(result.autoMode.projects).toHaveLength(1);
      expect(result.autoMode.projects[0].create.total).toBe(0);
      expect(result.autoMode.projects[0].held.total).toBe(1);
    });

    it('same auto-utworzenia (bez zawróceń) dają wiersz z held zerowanym', async () => {
      const fateRows: AutoModeFateRow[] = [
        { projectId: 'proj_a', projectName: 'Alpha', autoMode: true, type: 'create', total: 1, pruned: 0, overwritten: 0, archived: 0, undone: 0 },
      ];
      const result = await new UsageMetricsController(fakeUsage({ fateRows })).get();
      expect(result.autoMode.projects[0].held).toEqual({ total: 0, reasons: noReasons });
      expect(result.autoMode.projects[0].update.total).toBe(0);
    });

    it('brak danych auto mode → pusta lista projektów', async () => {
      const result = await new UsageMetricsController(fakeUsage({})).get();
      expect(result.autoMode).toEqual({ projects: [] });
    });

    it('from/to/projectId trafiają bez zmian do autoModeFates i autoHoldStats (bez bucket)', async () => {
      let fates: AutoModeMetricsFilter | undefined;
      let holds: AutoModeMetricsFilter | undefined;
      const controller = new UsageMetricsController(
        fakeUsage({ captureAutoFilters: (f, h) => ((fates = f), (holds = h)) }),
      );
      const from = new Date('2026-02-01T00:00:00Z');
      const to = new Date('2026-02-08T00:00:00Z');

      await controller.get({ from, to, projectId: 'proj_a', bucket: 'hour' });

      expect(fates).toEqual({ from, to, projectId: 'proj_a' });
      expect(holds).toEqual({ from, to, projectId: 'proj_a' });
    });
  });
});
