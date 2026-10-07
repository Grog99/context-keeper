import { Inject, Injectable } from '@nestjs/common';
import { and, asc, type AnyColumn, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { generateId, ID_PREFIX } from '../common/ids';
import { DB, type Database } from '../db/db.tokens';
import { projects, projectTokens, proposals, searchEvents } from '../db/schema';

/** Jedno źródło prawdy dla `bucket` (tech-review #3, roadmap v1.4) — `ZodValidationPipe`
 * (`dashboard.schemas.ts`) waliduje query po tej samej liście, zamiast po ręcznie przepisanej. */
export const USAGE_BUCKETS = ['day', 'hour'] as const;
export type UsageBucket = (typeof USAGE_BUCKETS)[number];

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
  /** Atrybucja per-agent (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") — opcjonalna
   * i nullable, purely additive: `null`/pominięte -> `search_events.token_id` zostaje `NULL` (np.
   * gdy `ctx` nie niesie tokena). */
  tokenId?: string | null;
  resultCount: number;
  degraded: boolean;
  /** Wyszukiwanie z `all_projects` (roadmap v1.5) — opcjonalne, brak = `false` (zwykłe wyszukiwanie). */
  crossProject?: boolean;
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
  crossProject: number;
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
      tokenId: input.tokenId ?? null,
      resultCount: input.resultCount,
      degraded: input.degraded,
      crossProject: input.crossProject ?? false,
    });
  }

  /**
   * Serie `search_events` per projekt (JOIN `projects` dla nazwy), zbucketowane `date_trunc(bucket, …)`.
   * `zeroResult` WYŁĄCZA zapytania `degraded` (plan §5(i) — degradacja embeddingu nie znaczy "pamięć
   * nie ma treści") ORAZ `cross_project` (roadmap v1.5 — wyszukiwanie po całej instancji rzadziej daje
   * 0 wyników i zaburzałoby ten sygnał); `degraded` i `crossProject` liczone osobno. `bucket` MUSI być zwalidowany przez wołającego
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
        zeroResult: sql<number>`count(*) FILTER (WHERE ${eq(searchEvents.resultCount, 0)} AND ${eq(searchEvents.degraded, false)} AND ${eq(searchEvents.crossProject, false)})::int`,
        degraded: sql<number>`count(*) FILTER (WHERE ${eq(searchEvents.degraded, true)})::int`,
        crossProject: sql<number>`count(*) FILTER (WHERE ${eq(searchEvents.crossProject, true)})::int`,
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
   * w `nightly.service.ts`). `withdrawn` wyłączone (samo-wycofanie maszynowe, nie decyzja człowieka); od v1.6 (A2) wyłączone
   * też auto-akceptacje (`auto_approved_at IS NOT NULL`) — to decyzje maszyny, nie recenzenta.
   * `approvedWithEdits` to PODZBIÓR `approved` (approved AND edited_payload IS NOT NULL), nie osobna
   * rozłączna kategoria.
   */
  async proposalOutcomeSeries(filter: UsageSeriesFilter): Promise<ProposalBucketRow[]> {
    const ts = dateTruncExpr(filter.bucket, proposals.updatedAt);
    const conditions = [
      inArray(proposals.status, ['approved', 'rejected']),
      // v1.6 A2 (G8): wykres mierzy decyzje CZŁOWIEKA — auto-akceptacje maszynowe nie wchodzą ani do
      // „zatwierdzonych", ani do „z edycją". Własne serie auto mode → A4.
      isNull(proposals.autoApprovedAt),
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

  /**
   * Kolumna "Wyszukań (30 dni)" w dialogu Tokeny (roadmap v1.3, "Wiele tokenów per projekt +
   * graceful rotation" — §0 pkt 7: per-token breakdown na ekranie "Pomiary" ODŁOŻONE, ten licznik
   * jest jedyną atrybucją wyszukań widoczną w tym passie). Zwraca `token_id -> liczba wyszukań`
   * dla WSZYSTKICH tokenów projektu od `since` — wiersze sprzed migracji v1.3 mają `token_id IS NULL`
   * i są celowo pominięte (brak przypisania do jakiegokolwiek konkretnego tokena).
   */
  async countSearchesByToken(projectId: string, since: Date): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ tokenId: searchEvents.tokenId, count: sql<number>`count(*)::int` })
      .from(searchEvents)
      .where(
        and(
          eq(searchEvents.projectId, projectId),
          isNotNull(searchEvents.tokenId),
          gte(searchEvents.createdAt, since),
        ),
      )
      .groupBy(searchEvents.tokenId);
    return new Map(rows.map((r) => [r.tokenId as string, r.count]));
  }

  /**
   * Odpowiednik `countSearchesByToken` dla TOKENÓW KONTA (roadmap v1.5, sekcja "Tokeny konta" na
   * ekranie Projekty) — token konta nie należy do projektu, więc nie ma filtra po `project_id`;
   * wyszukania z WSZYSTKICH projektów (`search_events.project_id` pochodzi z nagłówka) są sumowane per
   * `token_id`. INNER JOIN z `project_tokens` ogranicza wynik do tokenów konta (`project_id IS NULL`).
   */
  async countSearchesByAccountTokens(since: Date): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ tokenId: searchEvents.tokenId, count: sql<number>`count(*)::int` })
      .from(searchEvents)
      .innerJoin(projectTokens, eq(projectTokens.id, searchEvents.tokenId))
      .where(and(isNull(projectTokens.projectId), gte(searchEvents.createdAt, since)))
      .groupBy(searchEvents.tokenId);
    return new Map(rows.map((r) => [r.tokenId as string, r.count]));
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
