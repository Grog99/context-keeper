import { Inject, Injectable } from '@nestjs/common';
import { and, asc, type AnyColumn, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { generateId, ID_PREFIX } from '../common/ids';
import { DB, type Database } from '../db/db.tokens';
import { projects, proposals, searchEvents } from '../db/schema';

export type UsageBucket = 'day' | 'hour';

/**
 * Zwraca `date_trunc('day'|'hour', column, 'UTC')` jako fragment SQL z jednostką wklejoną literalnie
 * przez `sql.raw` (nie jako bound param) — MUSI dawać tekstowo IDENTYCZNY SQL przy każdym użyciu w
 * danym zapytaniu (SELECT / GROUP BY / ORDER BY), inaczej drizzle emituje osobny placeholder ($1 vs
 * $N) dla każdego wystąpienia i Postgres (42803) nie rozpoznaje pogrupowanego wyrażenia jako
 * pokrywającego niezagregowaną kolumnę źródłową. Bezpieczeństwo: `unit` pochodzi WYŁĄCZNIE z twardo
 * zakodowanego ternary poniżej (allowlist), NIGDY z surowej wartości wołającego — obrona w głębi,
 * mimo że kontroler (`usage-metrics.controller.ts`) już waliduje `bucket` przed wywołaniem serwisu.
 * 3-argumentowy `date_trunc(field, source, 'UTC')` (PG16+, mamy PG18) wymusza bucketowanie w UTC
 * niezależnie od strefy czasowej sesji DB — bez tego granice dnia/godziny dryfowałyby razem z TZ
 * serwera. `'UTC'` to stały literał wklejony bezpośrednio w szablonie (nie przez `${}`), więc jest
 * częścią surowego SQL, tak jak reszta nawiasów i przecinków — nie pochodzi od wołającego.
 */
function dateTruncExpr(bucket: UsageBucket, column: AnyColumn) {
  const unit = bucket === 'hour' ? 'hour' : 'day';
  return sql<Date>`date_trunc(${sql.raw(`'${unit}'`)}, ${column}, 'UTC')`;
}

export interface RecordSearchInput {
  projectId: string;
  resultCount: number;
  degraded: boolean;
}

export interface UsageSeriesFilter {
  from: Date;
  to: Date;
  bucket: UsageBucket;
  projectId?: string;
}

export interface SearchBucketRow {
  projectId: string;
  projectName: string;
  ts: Date;
  searches: number;
  zeroResult: number;
  degraded: number;
}

export interface ProposalBucketRow {
  ts: Date;
  approved: number;
  rejected: number;
  approvedWithEdits: number;
}

/**
 * Warstwa danych ekranu "Pomiary" (roadmap v1.1) — zapis `search_events` (jeden INSERT per
 * `search_memory`, wołany z `MemoryService.search()`) + odczyty zagregowane do wykresów/nagłówkowych
 * statystyk kontrolera `usage-metrics.controller.ts`. `recordSearch` CELOWO nie łapie własnych
 * błędów — fail-open (nigdy nie psuj dobrego search()) żyje u wołającego
 * (`MemoryService.recordSearchSafe`, Nest `Logger`), nie tutaj, żeby ta metoda pozostała zwykłym,
 * testowalnym INSERT-em bez ukrytego swallow.
 */
@Injectable()
export class UsageService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async recordSearch(input: RecordSearchInput): Promise<void> {
    await this.db.insert(searchEvents).values({
      id: generateId(ID_PREFIX.searchEvent),
      projectId: input.projectId,
      resultCount: input.resultCount,
      degraded: input.degraded,
    });
  }

  /**
   * Serie `search_events` per projekt (JOIN `projects` dla nazwy), zbucketowane `date_trunc(bucket, …)`.
   * `zeroResult` WYŁĄCZA zapytania `degraded` (plan §5(i) — degradacja embeddingu nie znaczy "pamięć
   * nie ma treści"), `degraded` liczony osobno. `bucket` MUSI być zwalidowany przez wołającego
   * (whitelist 'day'|'hour') PRZED wywołaniem — tu ufamy typowi `UsageBucket`.
   */
  async searchSeries(filter: UsageSeriesFilter): Promise<SearchBucketRow[]> {
    const ts = dateTruncExpr(filter.bucket, searchEvents.createdAt);
    const conditions = [gte(searchEvents.createdAt, filter.from), lt(searchEvents.createdAt, filter.to)];
    if (filter.projectId) conditions.push(eq(searchEvents.projectId, filter.projectId));

    const rows = await this.db
      .select({
        projectId: searchEvents.projectId,
        projectName: projects.name,
        ts,
        searches: sql<number>`count(*)::int`,
        zeroResult: sql<number>`count(*) FILTER (WHERE ${eq(searchEvents.resultCount, 0)} AND ${eq(searchEvents.degraded, false)})::int`,
        degraded: sql<number>`count(*) FILTER (WHERE ${eq(searchEvents.degraded, true)})::int`,
      })
      .from(searchEvents)
      .innerJoin(projects, eq(projects.id, searchEvents.projectId))
      .where(and(...conditions))
      .groupBy(searchEvents.projectId, projects.name, ts)
      .orderBy(asc(ts));

    // `sql<Date>` na `ts` to adnotacja WYŁĄCZNIE kompilacyjna — node-postgres realnie zwraca
    // date_trunc(...) (timestamptz) jako string, nie jako JS Date. Normalizujemy tu, żeby
    // `SearchBucketRow.ts` faktycznie dotrzymywał zadeklarowanego typu `Date` dla DTO/konsumentów.
    return rows.map((row) => ({ ...row, ts: new Date(row.ts as unknown as string | Date) }));
  }

  /**
   * Wynik decyzji recenzenta per bucket czasu, źródło = `proposals` (NIE `audit_log` — plan §1c,
   * scoping per-projekt bez heurystyki actor/affected_ids). `date_trunc(bucket, updated_at)` — dla
   * proposala terminalnego `updated_at` = moment decyzji (nie jest już potem dotykany, patrz komentarz
   * w `nightly.service.ts`). `withdrawn` wyłączone (samo-wycofanie maszynowe, nie decyzja człowieka).
   * `approvedWithEdits` to PODZBIÓR `approved` (approved AND edited_payload IS NOT NULL), nie osobna
   * rozłączna kategoria.
   */
  async proposalOutcomeSeries(filter: UsageSeriesFilter): Promise<ProposalBucketRow[]> {
    const ts = dateTruncExpr(filter.bucket, proposals.updatedAt);
    const conditions = [
      inArray(proposals.status, ['approved', 'rejected']),
      gte(proposals.updatedAt, filter.from),
      lt(proposals.updatedAt, filter.to),
    ];
    if (filter.projectId) conditions.push(eq(proposals.projectId, filter.projectId));

    const rows = await this.db
      .select({
        ts,
        approved: sql<number>`count(*) FILTER (WHERE ${eq(proposals.status, 'approved')})::int`,
        rejected: sql<number>`count(*) FILTER (WHERE ${eq(proposals.status, 'rejected')})::int`,
        approvedWithEdits: sql<number>`count(*) FILTER (WHERE ${eq(proposals.status, 'approved')} AND ${isNotNull(proposals.editedPayload)})::int`,
      })
      .from(proposals)
      .where(and(...conditions))
      .groupBy(ts)
      .orderBy(asc(ts));

    // `sql<Date>` na `ts` to adnotacja WYŁĄCZNIE kompilacyjna — node-postgres realnie zwraca
    // date_trunc(...) (timestamptz) jako string, nie jako JS Date. Normalizujemy tu, żeby
    // `ProposalBucketRow.ts` faktycznie dotrzymywał zadeklarowanego typu `Date` dla DTO/konsumentów.
    return rows.map((row) => ({ ...row, ts: new Date(row.ts as unknown as string | Date) }));
  }

  /** Retencja (plan §5(b/g), `SEARCH_EVENTS_RETENTION_DAYS`) — piggyback na nocnym jobie, zwraca
   * liczbę usuniętych wierszy do zliczenia w `NightlyCounters`. */
  async pruneOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(searchEvents)
      .where(lt(searchEvents.createdAt, cutoff))
      .returning({ id: searchEvents.id });
    return deleted.length;
  }
}
