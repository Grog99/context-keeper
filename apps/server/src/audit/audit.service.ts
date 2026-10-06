import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, getTableColumns, getTableName, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import { generateId, ID_PREFIX } from '../common/ids';
import { keysetAfter, keysetTs, pageByKeyset, type KeysetPosition } from '../common/keyset-cursor';
import { DB, type Database, type Tx } from '../db/db.tokens';
import { auditLog, memories, type AuditEventType, type AuditLogRow } from '../db/schema';

export interface LogAuditInput {
  eventType: AuditEventType;
  /** Identyfikator aktora — np. `agent:<project_id>` albo `human-dashboard` (§4). Nigdy surowy token. */
  actor: string;
  affectedIds?: string[];
  revisionId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Domyślny/maks. `limit` dla `GET /api/audit` (tech-review #3, roadmap v1.4, Q2 — bez zmiany
 * zachowania: 1..500, domyślnie 100). Jedno źródło prawdy dla kontrolera (`ZodValidationPipe`,
 * `dashboard.schemas.ts`) i tego serwisu, zamiast literału powielonego w obu miejscach. */
export const AUDIT_QUERY_DEFAULT_LIMIT = 100;
export const AUDIT_QUERY_MAX_LIMIT = 500;

export interface AuditQueryFilter {
  eventType?: AuditEventType;
  from?: Date;
  to?: Date;
  projectId?: string;
  limit?: number;
  /** Keyset `(created_at, id)` w pełnej precyzji (nightly-scale G6) — pozycja ostatniego wiersza z
   * poprzedniej strony, zdekodowana z opaque `nextCursor` (`decodeKeysetCursor`). Sam `createdAt` nie
   * wystarcza: wpisy z jednej transakcji mają identyczne `now()`, a `id` NIE jest sortowalny czasowo
   * (`generateId` to losowy nanoid, nie ULID) — więc `id` jest tylko rozstrzygaczem remisów. */
  cursor?: KeysetPosition;
}

/** Strona audytu: `nextCursor` (opaque, base64url) albo `null` na ostatniej stronie. */
export interface AuditPage {
  items: AuditLogRow[];
  nextCursor: string | null;
}

/**
 * Źródło wierszy dla filtra projektu: podzapytanie z płotkiem `OFFSET 0`, w którym siedzi WYŁĄCZNIE
 * predykat projektu (nightly-scale #7, D5):
 * `actor = 'agent:<id>' OR affected_ids && ARRAY(SELECT id FROM memories WHERE project_id = <id>)`.
 * Semantycznie to to samo co `EXISTS` (ustalenie 12), łącznie z pamięciami `archived`/`purged`
 * (ustalenie 13); pusty projekt -> `'{}'` -> `&&` fałszywe.
 *
 * Po co płotek: nieskorelowane `ARRAY(SELECT …)` planuje się jako InitPlan, a `&&` na wyniku InitPlanu
 * dostaje domyślną selektywność (~1%). Z `ORDER BY created_at DESC LIMIT n` planner uznaje wtedy, że
 * wystarczy chodzić `audit_created_at_idx` wstecz i filtrować — a filtr to `&&` z tablicą wszystkich
 * pamięci projektu, więc koszt to O(liczba pamięci) NA KAŻDY przejrzany wiersz audytu (zmierzone: 17 s
 * przy 1,14 mln wierszy dla nieaktywnego projektu z 2000 pamięci). `OFFSET 0` blokuje spłaszczenie
 * podzapytania i przesuwanie predykatów, więc projekt wybiera się wewnątrz przez
 * BitmapOr(`audit_actor_idx`, `audit_affected_ids_idx`), a sortowanie/limit działają na wyniku.
 * Sam `.offset(0)` z drizzle nic nie emituje (0.45 pomija offset 0), dlatego płotek to literalny fragment SQL (patrz `.offset(…)` niżej).
 *
 * Alias podzapytania celowo równa się nazwie tabeli (`audit_log`) — zewnętrzne odwołania
 * `"audit_log"."col"` (kolumny, `keysetAfter`, `keysetTs`, ORDER BY) wiążą się wtedy z podzapytaniem, a
 * drizzle (walidacja „tabela jest częścią zapytania”) akceptuje kolumny `auditLog` na takim aliasie.
 */
function projectScopedAuditLog(db: Database, projectId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      or(
        eq(auditLog.actor, `agent:${projectId}`),
        sql`${auditLog.affectedIds} && array(select ${memories.id} from ${memories} where ${memories.projectId} = ${projectId})`,
      ),
    )
    // Płotek musi być literalnym `offset 0` w SQL: `.offset(0)` z liczbą drizzle pomija (`if (offset)`), a
    // typ przyjmuje tylko number/Placeholder — stąd rzutowanie surowego `sql` (renderuje się jako ` offset 0`).
    .offset(sql`0` as unknown as number)
    .as(getTableName(auditLog));
}

/**
 * Zapytanie audytu jako builder drizzle (bez wykonania) — wydzielone, żeby testy mogły zrobić
 * `.toSQL()` -> `EXPLAIN` dokładnie tego, co jedzie do bazy. Filtr projektu to JEDNO zapytanie SQL
 * (nightly-scale #7) — predykat siedzi w podzapytaniu z płotkiem `OFFSET 0` (`projectScopedAuditLog`),
 * a `eventType`/`from`/`to`/kursor/`ORDER BY`/`LIMIT` zostają NA ZEWNĄTRZ (przeniesione do środka
 * przywracają zły plan: zakres po `audit_created_at_idx`). Bez `projectId` źródłem jest zwykła tabela.
 *
 * Koszt filtra projektu: O(pamięci projektu × wiersze audytu projektu) na stronę, niezależnie od
 * rozmiaru całego `audit_log` (≈0,1 s przy 2000 pamięci, ≈0,7 s przy 5000). Powyżej ~2000 pamięci na
 * projekt docelowym rozwiązaniem jest zdenormalizowane `project_id` w `audit_log` (tech-review #7).
 * Pobiera `limit + 1` wierszy (nadmiarowy służy tylko do wykrycia kolejnej strony).
 */
export function buildAuditQuery(db: Database, filter: AuditQueryFilter = {}) {
  const conditions: SQL[] = [];
  if (filter.eventType) conditions.push(eq(auditLog.eventType, filter.eventType));
  if (filter.from) conditions.push(gte(auditLog.createdAt, filter.from));
  if (filter.to) conditions.push(lte(auditLog.createdAt, filter.to));
  if (filter.cursor) conditions.push(keysetAfter(auditLog, filter.cursor, 'desc'));
  // Warunek projektu NIE trafia tutaj — siedzi w podzapytaniu (`projectScopedAuditLog`).
  const source = filter.projectId ? projectScopedAuditLog(db, filter.projectId) : auditLog;

  return db
    .select({ ...getTableColumns(auditLog), cursorTs: keysetTs(auditLog.createdAt) })
    .from(source)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit((filter.limit ?? AUDIT_QUERY_DEFAULT_LIMIT) + 1);
}

/**
 * Append-only audit (§4, NFR-2). Faza 2 potrzebowała tylko zapisu — odczyty/filtrowanie (FR-D4)
 * dochodzą w Fazie 5.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * `executor` (opcjonalny): przekaż `tx` gdy wołasz wewnątrz `db.transaction(...)` (np.
   * `ProposalsService.approve`) — wpis audytu wtedy współdzieli atomiczność z mutacją i znika razem
   * z nią przy rollbacku (np. stale check). Domyślnie pisze przez wstrzykniętą globalną instancję.
   */
  async log(input: LogAuditInput, executor: Database | Tx = this.db): Promise<void> {
    await executor.insert(auditLog).values({
      id: generateId(ID_PREFIX.audit),
      eventType: input.eventType,
      actor: input.actor,
      affectedIds: input.affectedIds ?? [],
      revisionId: input.revisionId ?? null,
      metadata: input.metadata ?? null,
    });
  }

  /** FR-D4 — tabela audytu, filtrowalna. `audit_log` nie ma kolumny `project_id` (append-only, poza
   * kluczami obcymi — patrz `db/schema/audit-log.ts`), więc `projectId` to HEURYSTYKA, nie twardy
   * filtr: dopasowanie po `actor='agent:<projectId>'` (konwencja `MemoryService.save`) ORAZ po
   * `affected_ids` przecinających się z pamięciami danego projektu (pokrywa `human-dashboard`/CLI) —
   * w jednym zapytaniu, z predykatem w podzapytaniu `OFFSET 0` (płotek planera: bez niego `&&` z
   * InitPlanem dostaje ~1% selektywności i planner chodzi `audit_created_at_idx` wstecz z filtrem
   * O(liczba pamięci) na wiersz). Koszt: O(pamięci projektu × wiersze audytu projektu) na stronę,
   * niezależnie od rozmiaru `audit_log`; powyżej ~2000 pamięci na projekt potrzebne jest
   * zdenormalizowane `project_id` (tech-review #7) — patrz `buildAuditQuery`. Kolejność
   * `created_at DESC, id DESC`, paginacja kursorem keyset w pełnej precyzji. */
  async query(filter: AuditQueryFilter = {}): Promise<AuditPage> {
    const limit = filter.limit ?? AUDIT_QUERY_DEFAULT_LIMIT;
    const rows = await buildAuditQuery(this.db, filter);
    return pageByKeyset(rows, limit);
  }

  async latestByEventType(eventType: AuditEventType): Promise<AuditLogRow | null> {
    const [row] = await this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, eventType))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    return row ?? null;
  }

  async countSince(eventType: AuditEventType, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(eq(auditLog.eventType, eventType), gte(auditLog.createdAt, since)));
    return row?.count ?? 0;
  }
}
