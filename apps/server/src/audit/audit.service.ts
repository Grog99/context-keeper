import { Inject, Injectable } from '@nestjs/common';
import { and, arrayOverlaps, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';
import { generateId, ID_PREFIX } from '../common/ids';
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

export interface AuditQueryFilter {
  eventType?: AuditEventType;
  from?: Date;
  to?: Date;
  projectId?: string;
  limit?: number;
  /** Keyset: ISO `createdAt` ostatniego wiersza z poprzedniej strony (audit rośnie ciągle, `id` NIE
   * jest sortowalny czasowo — `generateId` to losowy nanoid, nie ULID). */
  cursor?: string;
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
   * `affected_ids` przecinających się z pamięciami danego projektu (pokrywa `human-dashboard`/CLI). */
  async query(filter: AuditQueryFilter = {}): Promise<AuditLogRow[]> {
    const conditions = [];
    if (filter.eventType) conditions.push(eq(auditLog.eventType, filter.eventType));
    if (filter.from) conditions.push(gte(auditLog.createdAt, filter.from));
    if (filter.to) conditions.push(lte(auditLog.createdAt, filter.to));
    if (filter.cursor) {
      const cursorDate = new Date(filter.cursor);
      if (!Number.isNaN(cursorDate.getTime())) conditions.push(lt(auditLog.createdAt, cursorDate));
    }
    if (filter.projectId) {
      const projectMemories = await this.db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.projectId, filter.projectId));
      const memoryIds = projectMemories.map((m) => m.id);
      const projectConditions = [eq(auditLog.actor, `agent:${filter.projectId}`)];
      if (memoryIds.length > 0) projectConditions.push(arrayOverlaps(auditLog.affectedIds, memoryIds));
      conditions.push(or(...projectConditions)!);
    }

    return this.db
      .select()
      .from(auditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.createdAt))
      .limit(filter.limit ?? 100);
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
