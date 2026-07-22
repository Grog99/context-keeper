import { Inject, Injectable } from '@nestjs/common';
import { generateId, ID_PREFIX } from '../common/ids';
import { DB, type Database, type Tx } from '../db/db.tokens';
import { auditLog, type AuditEventType } from '../db/schema';

export interface LogAuditInput {
  eventType: AuditEventType;
  /** Identyfikator aktora — np. `agent:<project_id>` albo `human-dashboard` (§4). Nigdy surowy token. */
  actor: string;
  affectedIds?: string[];
  revisionId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit (§4, NFR-2). Faza 2 potrzebuje tylko zapisu (`proposal_created`, `secret_blocked`) —
 * odczyty/filtrowanie w dashboardzie to Faza 5.
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
}
