import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ToolError } from '../common/errors';
import type { ProposalBucketRow, SearchBucketRow, UsageBucket } from '../usage/usage.service';
import { UsageService } from '../usage/usage.service';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DashboardErrorFilter } from './dashboard-error.filter';

const VALID_BUCKETS: readonly UsageBucket[] = ['day', 'hour'];
const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

export interface UsageBucketPointDto {
  ts: string;
  searches: number;
  zeroResult: number;
  degraded: number;
}

export interface ProjectSearchSeriesDto {
  projectId: string;
  projectName: string;
  /** Headline "zero-result rate per project" (plan §5(i)) — sumy dla całego zakresu, `degraded`
   * WYŁĄCZONE z `zeroResult`/`zeroResultRate` (degradacja embeddingu ≠ "pamięć nie ma treści"). */
  totals: { searches: number; zeroResult: number; degraded: number; zeroResultRate: number };
  buckets: UsageBucketPointDto[];
}

export interface ProposalBucketPointDto {
  ts: string;
  approved: number;
  rejected: number;
  /** PODZBIÓR `approved` (approved AND edited_payload IS NOT NULL) — NIE osobna rozłączna kategoria. */
  approvedWithEdits: number;
}

export interface UsageMetricsDto {
  range: { from: string; to: string; bucket: UsageBucket };
  searchSeries: ProjectSearchSeriesDto[];
  searchTotals: { searches: number; zeroResult: number; degraded: number; zeroResultRate: number };
  proposalSeries: {
    buckets: ProposalBucketPointDto[];
    totals: { approved: number; rejected: number; approvedWithEdits: number };
  };
}

function zeroResultRate(searches: number, zeroResult: number): number {
  return searches === 0 ? 0 : zeroResult / searches;
}

/**
 * Ekran "Pomiary" (roadmap v1.1, plan §5): `search_memory` per projekt w czasie, 0-result rate
 * (nagłówkowy sygnał §5(i), `degraded` wyłączone z tego sygnału) + accept/reject/edit proposali
 * (`edit` = approved-with-edits, podzbiór accepted — §5(f)). Guardy DOKŁADNIE jak `MetricsController`
 * (kontroler-scoped, `SessionGuard`+`CsrfGuard`, NIGDY globalne — `/mcp` nie może dostać nowego
 * globalnego guarda).
 */
@Controller('api/metrics/usage')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class UsageMetricsController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  async get(
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
    @Query('bucket') bucketRaw?: string,
    @Query('projectId') projectId?: string,
  ): Promise<UsageMetricsDto> {
    const bucket = this.parseBucket(bucketRaw);
    const to = this.parseDate('to', toRaw) ?? new Date();
    const from = this.parseDate('from', fromRaw) ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);

    const [searchRows, proposalRows] = await Promise.all([
      this.usage.searchSeries({ from, to, bucket, projectId }),
      this.usage.proposalOutcomeSeries({ from, to, bucket, projectId }),
    ]);

    const searchSeries = this.shapeSearchSeries(searchRows);

    return {
      range: { from: from.toISOString(), to: to.toISOString(), bucket },
      searchSeries,
      searchTotals: this.sumSearchTotals(searchSeries),
      proposalSeries: this.shapeProposalSeries(proposalRows),
    };
  }

  /** Whitelist server-side (plan §2 krok 8) — `date_trunc`-owalna wartość, nigdy dowolny string z query. */
  private parseBucket(raw: string | undefined): UsageBucket {
    if (raw === undefined) return 'day';
    if (!VALID_BUCKETS.includes(raw as UsageBucket)) {
      throw new ToolError('validation_error', `bucket musi być jednym z: ${VALID_BUCKETS.join(', ')}`);
    }
    return raw as UsageBucket;
  }

  private parseDate(field: 'from' | 'to', raw: string | undefined): Date | undefined {
    if (raw === undefined || raw === '') return undefined;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new ToolError('validation_error', `${field}: nieprawidłowa data ISO — "${raw}"`);
    }
    return parsed;
  }

  /** Kształtuje surowe wiersze `(projectId, projectName, ts, …)` w serie per projekt (plan §2 krok 8
   * "Shape rows into per-project series in JS") — jedno zapytanie SQL, agregacja tutaj. */
  private shapeSearchSeries(rows: SearchBucketRow[]): ProjectSearchSeriesDto[] {
    const byProject = new Map<string, ProjectSearchSeriesDto>();
    for (const row of rows) {
      let entry = byProject.get(row.projectId);
      if (!entry) {
        entry = {
          projectId: row.projectId,
          projectName: row.projectName,
          totals: { searches: 0, zeroResult: 0, degraded: 0, zeroResultRate: 0 },
          buckets: [],
        };
        byProject.set(row.projectId, entry);
      }
      entry.buckets.push({
        ts: row.ts.toISOString(),
        searches: row.searches,
        zeroResult: row.zeroResult,
        degraded: row.degraded,
      });
      entry.totals.searches += row.searches;
      entry.totals.zeroResult += row.zeroResult;
      entry.totals.degraded += row.degraded;
    }
    for (const entry of byProject.values()) {
      entry.totals.zeroResultRate = zeroResultRate(entry.totals.searches, entry.totals.zeroResult);
    }
    return Array.from(byProject.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
  }

  private sumSearchTotals(series: ProjectSearchSeriesDto[]): UsageMetricsDto['searchTotals'] {
    const totals = series.reduce(
      (acc, s) => ({
        searches: acc.searches + s.totals.searches,
        zeroResult: acc.zeroResult + s.totals.zeroResult,
        degraded: acc.degraded + s.totals.degraded,
      }),
      { searches: 0, zeroResult: 0, degraded: 0 },
    );
    return { ...totals, zeroResultRate: zeroResultRate(totals.searches, totals.zeroResult) };
  }

  private shapeProposalSeries(rows: ProposalBucketRow[]): UsageMetricsDto['proposalSeries'] {
    const buckets = rows.map((r) => ({
      ts: r.ts.toISOString(),
      approved: r.approved,
      rejected: r.rejected,
      approvedWithEdits: r.approvedWithEdits,
    }));
    const totals = buckets.reduce(
      (acc, b) => ({
        approved: acc.approved + b.approved,
        rejected: acc.rejected + b.rejected,
        approvedWithEdits: acc.approvedWithEdits + b.approvedWithEdits,
      }),
      { approved: 0, rejected: 0, approvedWithEdits: 0 },
    );
    return { buckets, totals };
  }
}
