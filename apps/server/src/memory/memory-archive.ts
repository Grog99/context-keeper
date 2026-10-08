import { or, sql } from 'drizzle-orm';
import type { AuditService } from '../audit/audit.service';
import { generateId, ID_PREFIX } from '../common/ids';
import { idsAny } from '../common/sql-helpers';
import type { Tx } from '../db/db.tokens';
import { embeddings, memories, memoryRelations, revisions, type MemoryRelationRow, type MemoryRow } from '../db/schema';

/** Snapshot pamięci zapisywany w rewizji (stan SPRZED mutacji). */
export function snapshotOf(row: MemoryRow): Record<string, unknown> {
  return { header: row.header, body: row.body, tags: row.tags, kind: row.kind, version: row.version, eventTime: row.eventTime };
}

/**
 * Audyt kaskady usunięcia krawędzi (code review finding „kaskada bez audytu", roadmap v1.2) — wspólne dla
 * archiwizacji (pojedynczej i masowej) i `promoteToGlobal`: obie operacje wyjmują pamięć z grafu JEJ projektu,
 * więc dotykające ją krawędzie giną i muszą zostawić ślad w append-only audycie, tak samo jak ręczne
 * `removeRelation`. `via` rozróżnia kaskadę (`archive`/`promote`) od ręcznego usunięcia (`via: 'human'`).
 */
export async function auditRemovedRelations(
  tx: Tx,
  audit: AuditService,
  actor: string,
  deleted: MemoryRelationRow[],
  via: 'archive' | 'promote',
): Promise<void> {
  for (const rel of deleted) {
    await audit.log(
      {
        eventType: 'relation_removed',
        actor,
        affectedIds: [rel.fromMemoryId, rel.toMemoryId],
        metadata: {
          relationId: rel.id,
          type: rel.type,
          fromMemoryId: rel.fromMemoryId,
          toMemoryId: rel.toMemoryId,
          via,
        },
      },
      tx,
    );
  }
}

/**
 * Soft-delete jednej lub wielu pamięci W ISTNIEJĄCEJ transakcji — jedyna implementacja archiwizacji człowieka
 * (ręcznej `MemoryAdminService.archiveMemory` i masowego cofania auto mode, A3), więc obie zachowują się
 * identycznie z konstrukcji: `status='archived'`, `version+1`, zdjęcie `auto_approved_at` (G6), kasowanie
 * embeddingów i krawędzi grafu, rewizja `archive` (snapshot sprzed mutacji), audyt `archive` per pamięć i
 * `relation_removed` per krawędź (`via:'archive'`). Set-based (`= any($ids)`), więc koszt to stała liczba
 * zapytań + po jednym INSERT-cie audytu na pamięć/krawędź.
 *
 * `rows` to wiersze odczytane przez wołającego (najlepiej pod `FOR UPDATE`) — ich stan służy za snapshot
 * rewizji. `auditMetadata` (opcjonalne) trafia do audytu `archive` każdej pamięci — cofanie auto mode
 * oznacza nim źródło (`via`, `undoId`); ręczna archiwizacja zostawia `metadata = null`.
 */
export async function archiveMemoriesInTx(
  tx: Tx,
  audit: AuditService,
  rows: readonly MemoryRow[],
  opts: { actor: string; auditMetadata?: Record<string, unknown> },
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);

  await tx
    .update(memories)
    .set({
      status: 'archived',
      version: sql`${memories.version} + 1`,
      updatedAt: new Date(),
      autoApprovedAt: null, // G6
    })
    .where(idsAny(memories.id, ids));
  await tx.delete(embeddings).where(idsAny(embeddings.memoryId, ids));
  const deletedRelations = await tx
    .delete(memoryRelations)
    .where(or(idsAny(memoryRelations.fromMemoryId, ids), idsAny(memoryRelations.toMemoryId, ids)))
    .returning();
  await tx.insert(revisions).values(
    rows.map((row) => ({
      id: generateId(ID_PREFIX.revision),
      memoryId: row.id,
      action: 'archive' as const,
      actor: opts.actor,
      snapshot: snapshotOf(row),
    })),
  );
  for (const row of rows) {
    await audit.log(
      {
        eventType: 'archive',
        actor: opts.actor,
        affectedIds: [row.id],
        ...(opts.auditMetadata ? { metadata: opts.auditMetadata } : {}),
      },
      tx,
    );
  }
  await auditRemovedRelations(tx, audit, opts.actor, deletedRelations, 'archive');
}

