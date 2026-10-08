import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import type { AutoHoldReason } from '../db/schema';
import type {
  AutoHoldRow,
  AutoModeFateRow,
  ProposalBucketRow,
  SearchBucketRow,
  UsageBucket,
} from '../usage/usage.service';
import { UsageService } from '../usage/usage.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { type UsageQuery, usageQuery } from './dashboard.schemas';
import { DashboardErrorFilter } from './dashboard-error.filter';

const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

export interface UsageBucketPointDto {
  ts: string;
  searches: number;
  zeroResult: number;
  degraded: number;
  /** Wyszukiwania z `all_projects` (roadmap v1.5) — PODZBIÓR `searches`, wyłączony z zero-result. */
  crossProject: number;
}

export interface ProjectSearchSeriesDto {
  projectId: string;
  projectName: string;
  /** Headline "zero-result rate per project" (plan §5(i)) — sumy dla całego zakresu, `degraded`
   * WYŁĄCZONE z `zeroResult`/`zeroResultRate` (degradacja embeddingu ≠ "pamięć nie ma treści");
   * wyszukiwania cross-project (`crossProject`, roadmap v1.5) wyłączone z licznika I mianownika
   * `zeroResultRate`, ale nadal wliczone w `searches`. */
  totals: {
    searches: number;
    zeroResult: number;
    degraded: number;
    crossProject: number;
    zeroResultRate: number;
  };
  buckets: UsageBucketPointDto[];
}

export interface ProposalBucketPointDto {
  ts: string;
  approved: number;
  rejected: number;
  /** PODZBIÓR `approved` (approved AND edited_payload IS NOT NULL) — NIE osobna rozłączna kategoria. */
  approvedWithEdits: number;
}

/** Los auto-akceptacji jednego typu (A4): `total` = kohorta, kubełki rozłączne, `untouched` = reszta (`total − Σ`). */
export interface AutoModeFateCountsDto {
  total: number;
  pruned: number;
  overwritten: number;
  archived: number;
  undone: number;
  untouched: number;
}

export interface AutoModeProjectDto {
  projectId: string;
  projectName: string;
  /** Przełącznik DZIŚ — projekt z wyłączonym auto mode, ale z historią w zakresie, dalej ma wiersz. */
  autoModeEnabled: boolean;
  create: AutoModeFateCountsDto;
  update: AutoModeFateCountsDto;
  /** Zawrócone przez bezpiecznik: `total` = propozycje (raz), `reasons` per powód (suma powodów ≥ `total`). */
  held: { total: number; reasons: Record<AutoHoldReason, number> };
}

export interface UsageMetricsDto {
  range: { from: string; to: string; bucket: UsageBucket };
  searchSeries: ProjectSearchSeriesDto[];
  searchTotals: {
    searches: number;
    zeroResult: number;
    degraded: number;
    crossProject: number;
    zeroResultRate: number;
  };
  proposalSeries: {
    buckets: ProposalBucketPointDto[];
    totals: { approved: number; rejected: number; approvedWithEdits: number };
  };
  /** Sekcja auto mode (A4): wiersz na projekt z auto-akceptacjami lub zawróceniami w zakresie. Bez serii czasowej. */
  autoMode: { projects: AutoModeProjectDto[] };
}

function emptyFateCounts(): AutoModeFateCountsDto {
  return { total: 0, pruned: 0, overwritten: 0, archived: 0, undone: 0, untouched: 0 };
}

function emptyReasons(): Record<AutoHoldReason, number> {
  return { near_duplicate: 0, not_computed: 0, human_target: 0, daily_limit: 0, auto_failed: 0 };
}

/** Cross-project (`crossProject`) wypada z mianownika tak samo jak z licznika (`zeroResult` ich nie
 * zawiera) — liczymy tylko zwykłe wyszukiwania; 0, gdy takich nie było. */
function zeroResultRate(searches: number, zeroResult: number, crossProject: number): number {
  const denominator = searches - crossProject;
  return denominator === 0 ? 0 : zeroResult / denominator;
}

/**
 * Ekran "Pomiary" (roadmap v1.1, plan §5): `search_memory` per projekt w czasie, 0-result rate
 * (nagłówkowy sygnał §5(i), `degraded` i wyszukiwania cross-project wyłączone z tego sygnału) + accept/reject/edit proposali
 * (`edit` = approved-with-edits, podzbiór accepted — §5(f)). Guardy DOKŁADNIE jak `MetricsController`
 * (kontroler-scoped, `SessionGuard`+`CsrfGuard`, NIGDY globalne — `/mcp` nie może dostać nowego
 * globalnego guarda).
 *
 * Od v1.6 (A4) odpowiedź niesie też `autoMode` — los auto-akceptacji (kohorta wg `auto_approved_at` w zakresie,
 * liczony do teraz) i powody zawróceń per projekt; ten sam zakres/`projectId` co reszta, `bucket` go nie dotyczy.
 *
 * Walidacja query (tech-review #3, roadmap v1.4) — `usageQuery` (`dashboard.schemas.ts`) zastępuje
 * `parseBucket`/`parseDate` inline: `bucket` z `USAGE_BUCKETS`, `from`/`to` jako `Date`. Domyślny
 * bucket/zakres (`day`, ostatnie 30 dni) zostają TUTAJ, w kontrolerze — nie są kształtem wejścia.
 */
@Controller('api/metrics/usage')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class UsageMetricsController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  async get(
    @Query(new ZodValidationPipe(usageQuery)) query: UsageQuery = {},
  ): Promise<UsageMetricsDto> {
    const bucket = query.bucket ?? 'day';
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);

    const [searchRows, proposalRows, fateRows, holdRows] = await Promise.all([
      this.usage.searchSeries({ from, to, bucket, projectId: query.projectId }),
      this.usage.proposalOutcomeSeries({ from, to, bucket, projectId: query.projectId }),
      this.usage.autoModeFates({ from, to, projectId: query.projectId }),
      this.usage.autoHoldStats({ from, to, projectId: query.projectId }),
    ]);

    const searchSeries = this.shapeSearchSeries(searchRows);

    return {
      range: { from: from.toISOString(), to: to.toISOString(), bucket },
      searchSeries,
      searchTotals: this.sumSearchTotals(searchSeries),
      proposalSeries: this.shapeProposalSeries(proposalRows),
      autoMode: { projects: this.shapeAutoMode(fateRows, holdRows) },
    };
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
          totals: { searches: 0, zeroResult: 0, degraded: 0, crossProject: 0, zeroResultRate: 0 },
          buckets: [],
        };
        byProject.set(row.projectId, entry);
      }
      entry.buckets.push({
        ts: row.ts.toISOString(),
        searches: row.searches,
        zeroResult: row.zeroResult,
        degraded: row.degraded,
        crossProject: row.crossProject,
      });
      entry.totals.searches += row.searches;
      entry.totals.zeroResult += row.zeroResult;
      entry.totals.degraded += row.degraded;
      entry.totals.crossProject += row.crossProject;
    }
    for (const entry of byProject.values()) {
      entry.totals.zeroResultRate = zeroResultRate(
        entry.totals.searches,
        entry.totals.zeroResult,
        entry.totals.crossProject,
      );
    }
    return Array.from(byProject.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
  }

  private sumSearchTotals(series: ProjectSearchSeriesDto[]): UsageMetricsDto['searchTotals'] {
    const totals = series.reduce(
      (acc, s) => ({
        searches: acc.searches + s.totals.searches,
        zeroResult: acc.zeroResult + s.totals.zeroResult,
        degraded: acc.degraded + s.totals.degraded,
        crossProject: acc.crossProject + s.totals.crossProject,
      }),
      { searches: 0, zeroResult: 0, degraded: 0, crossProject: 0 },
    );
    return {
      ...totals,
      zeroResultRate: zeroResultRate(totals.searches, totals.zeroResult, totals.crossProject),
    };
  }

  /** Skleja wiersze losu (projekt × typ) i zawróceń (projekt) w jeden wiersz na projekt; brakujące części zerowane,
   * `untouched` = reszta kohorty po odjęciu rozłącznych kubełków. Sortowanie po nazwie projektu. */
  private shapeAutoMode(fateRows: AutoModeFateRow[], holdRows: AutoHoldRow[]): AutoModeProjectDto[] {
    const byProject = new Map<string, AutoModeProjectDto>();
    const entryFor = (projectId: string, projectName: string, autoModeEnabled: boolean): AutoModeProjectDto => {
      let entry = byProject.get(projectId);
      if (!entry) {
        entry = {
          projectId,
          projectName,
          autoModeEnabled,
          create: emptyFateCounts(),
          update: emptyFateCounts(),
          held: { total: 0, reasons: emptyReasons() },
        };
        byProject.set(projectId, entry);
      }
      return entry;
    };
    for (const row of fateRows) {
      const entry = entryFor(row.projectId, row.projectName, row.autoMode);
      entry[row.type] = {
        total: row.total,
        pruned: row.pruned,
        overwritten: row.overwritten,
        archived: row.archived,
        undone: row.undone,
        untouched: row.total - row.pruned - row.overwritten - row.archived - row.undone,
      };
    }
    for (const row of holdRows) {
      const entry = entryFor(row.projectId, row.projectName, row.autoMode);
      entry.held = { total: row.held, reasons: { ...emptyReasons(), ...row.reasons } };
    }
    return Array.from(byProject.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
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
