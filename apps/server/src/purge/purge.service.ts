import { Inject, Injectable } from '@nestjs/common';
import { and, arrayOverlaps, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { DB, type Database, type Tx } from '../db/db.tokens';
import { embeddings, memories, memoryRelations, proposals, revisions, stagingEmbeddings } from '../db/schema';
import type { MemoryStatus } from '../db/schema/enums';
import { PurgeError } from './purge.errors';

const TOMBSTONE_HEADER = '[purged]';

export interface PurgePreview {
  id: string;
  status: MemoryStatus;
  header: string;
  embeddingsCount: number;
  relatedProposalsCount: number;
  revisionsWithContentCount: number;
  /** Krawędzie `memory_relations` dotykające tę pamięć — roadmap v1.2 (nie niosą treści same w
   * sobie, ale purge je i tak usuwa razem z resztą, patrz `purge()`). */
  relationsCount: number;
}

export interface PurgeOptions {
  /** Wymagany — jedyny zapis "dlaczego" dla tej nieodwracalnej operacji (§10 tech-stack, trafia do
   * `audit_log.metadata`, NIGDY materiał sekretu — sam powód, np. "AWS key w body"). */
  reason: string;
  actor: string;
}

export interface PurgeResult {
  id: string;
  embeddingsDeleted: number;
  stagingEmbeddingsDeleted: number;
  proposalsRedacted: number;
  revisionsRedacted: number;
  /** Roadmap v1.2 — krawędzie usunięte razem z tombstone'em (mirror embeddings, §PurgeService.purge). */
  relationsDeleted: number;
}

/** Proposale referencujące `memoryId` — przez `affected_ids` (update/merge/delete) ALBO
 * `payload.memoryId`/`edited_payload.memoryId` (create/merge trzymają docelowe id WYŁĄCZNIE w
 * payloadzie, nigdy w affected_ids, patrz `ProposalsService.materializeMemory`). */
function relatedProposalsCondition(memoryId: string): SQL {
  return or(
    arrayOverlaps(proposals.affectedIds, [memoryId]),
    sql`${proposals.payload} ->> 'memoryId' = ${memoryId}`,
    sql`${proposals.editedPayload} ->> 'memoryId' = ${memoryId}`,
  )!;
}

/** Zamienia WYŁĄCZNIE pola niosące treść (`header`/`body`/`tags`) na placeholder, zostawiając
 * resztę kształtu (`memoryId`/`kind`) nietkniętą — payload dalej wygląda jak `ProposalPayload`
 * dla każdego konsumenta (dashboard, `pickEffectivePayload`), tylko bez treści do wycieku. */
function redactPayloadContent(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if ('header' in obj) obj.header = TOMBSTONE_HEADER;
  if ('body' in obj) obj.body = '';
  if ('tags' in obj) obj.tags = [];
  return obj;
}

/**
 * Hard-purge (FR-S3, §10 tech-stack) — uprzywilejowana, rzadka, NIEODWRACALNA remediacja dla
 * treści, które soft-delete (`archived`, NFR-6) nie umie usunąć: wycieki sekretów/PII. Wywoływana
 * z CLI (`cli/purge.command.ts`) albo od roadmap v1.1 z dashboardu (`MemoriesController`,
 * `PurgeMemoryDialog`) — NIGDY przez MCP: `preview()`/`purge()` żyją wyłącznie za
 * `SessionGuard`/`CsrfGuard` kontroler-scoped na powierzchni dashboardu, nie za publicznym `/mcp`.
 *
 * Nie łamie zasady soft-delete — jeździ NA archive'owaniu (status='purged', budowany na tej samej
 * mechanice co `ProposalsService.archiveMemory`/`MemoryAdminService.archiveMemory`), tylko
 * DODATKOWO wymazuje treść we wszystkich content-bearing tabelach zamiast ją zachować.
 */
@Injectable()
export class PurgeService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Read-only podgląd (dry-run) — BEZ mutacji, BEZ locka (display-only, jak `listPending`).
   * Woła CLI, gdy operator nie podał `--confirm`, żeby zobaczyć skalę zanim zdecyduje. */
  async preview(memoryId: string): Promise<PurgePreview> {
    const [row] = await this.db.select().from(memories).where(eq(memories.id, memoryId)).limit(1);
    if (!row) throw new PurgeError('not_found', `Pamięć nie istnieje: ${memoryId}`);

    const [embRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(embeddings)
      .where(eq(embeddings.memoryId, memoryId));

    const relatedProposals = await this.db
      .select({ id: proposals.id })
      .from(proposals)
      .where(relatedProposalsCondition(memoryId));

    const [revRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(revisions)
      .where(and(eq(revisions.memoryId, memoryId), isNotNull(revisions.snapshot)));

    const [relRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(memoryRelations)
      .where(or(eq(memoryRelations.fromMemoryId, memoryId), eq(memoryRelations.toMemoryId, memoryId)));

    return {
      id: row.id,
      status: row.status,
      header: row.header,
      embeddingsCount: embRow?.count ?? 0,
      relatedProposalsCount: relatedProposals.length,
      revisionsWithContentCount: revRow?.count ?? 0,
      relationsCount: relRow?.count ?? 0,
    };
  }

  /**
   * Transakcyjny rdzeń — mirror `ProposalsService.approve` (row-lock, §8bis): (a) lock + tombstone
   * `memories` (header/body/tags wymazane, `status='purged'`, `version+1`); (b) usuń `embeddings`;
   * (c) zredaguj `payload`/`edited_payload` KAŻDEGO proposala referencującego tę pamięć (lock +
   * update, nie delete — proposal zostaje dla audytu, jak reject/approve); (d) posprzątaj
   * `staging_embeddings` tych proposali (defensywnie — normalnie już puste po approve/reject);
   * (e) wyzeruj `revisions.snapshot` tam gdzie niósł treść; (f) `audit_log` typu `purge_tombstone`.
   *
   * `version+1` na `memories` to NIE tylko kosmetyka — pending proposal celujący w tę pamięć
   * (update/merge/delete) ma zapisany `base_versions` sprzed purge; przy próbie `approve()` rozjazd
   * wykryje go jako `stale` (FR-Q7) i zablokuje, więc nic nie nadpisze świeżo wymazanego tombstone'a.
   */
  async purge(memoryId: string, opts: PurgeOptions): Promise<PurgeResult> {
    if (!opts.reason?.trim()) {
      throw new PurgeError('validation_error', '--reason jest wymagany dla hard-purge (trafia do audit_log)');
    }

    return this.db.transaction(async (tx: Tx) => {
      const [row] = await tx.select().from(memories).where(eq(memories.id, memoryId)).for('update');
      if (!row) throw new PurgeError('not_found', `Pamięć nie istnieje: ${memoryId}`);
      if (row.status === 'purged') {
        throw new PurgeError('already_purged', `Pamięć ${memoryId} jest już wymazana (purge_tombstone)`);
      }

      await tx
        .update(memories)
        .set({
          header: TOMBSTONE_HEADER,
          body: '',
          tags: [],
          status: 'purged',
          version: sql`${memories.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(memories.id, memoryId));

      const deletedEmbeddings = await tx
        .delete(embeddings)
        .where(eq(embeddings.memoryId, memoryId))
        .returning({ id: embeddings.id });

      // Roadmap v1.2 — krawędzie grafu nie niosą treści, ale purge jest nieodwracalnym wymazaniem
      // WSZYSTKICH śladów pamięci (nie tylko sekretu w treści) — mirror embeddings, przed
      // redagowaniem proposali niżej (kolejność nieistotna, osobna tabela bez zależności).
      const deletedRelations = await tx
        .delete(memoryRelations)
        .where(or(eq(memoryRelations.fromMemoryId, memoryId), eq(memoryRelations.toMemoryId, memoryId)))
        .returning({ id: memoryRelations.id });

      const relatedProposals = await tx
        .select()
        .from(proposals)
        .where(relatedProposalsCondition(memoryId))
        .for('update');

      for (const p of relatedProposals) {
        await tx
          .update(proposals)
          .set({
            payload: redactPayloadContent(p.payload),
            editedPayload: p.editedPayload ? redactPayloadContent(p.editedPayload) : null,
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, p.id));
      }

      let stagingEmbeddingsDeleted = 0;
      const proposalIds = relatedProposals.map((p) => p.id);
      if (proposalIds.length > 0) {
        const deletedStaging = await tx
          .delete(stagingEmbeddings)
          .where(inArray(stagingEmbeddings.proposalId, proposalIds))
          .returning({ id: stagingEmbeddings.id });
        stagingEmbeddingsDeleted = deletedStaging.length;
      }

      const redactedRevisions = await tx
        .update(revisions)
        .set({ snapshot: null })
        .where(and(eq(revisions.memoryId, memoryId), isNotNull(revisions.snapshot)))
        .returning({ id: revisions.id });

      await this.audit.log(
        {
          eventType: 'purge_tombstone',
          actor: opts.actor,
          affectedIds: [memoryId],
          metadata: {
            reason: opts.reason,
            embeddingsDeleted: deletedEmbeddings.length,
            proposalsRedacted: relatedProposals.length,
            revisionsRedacted: redactedRevisions.length,
            stagingEmbeddingsDeleted,
            relationsDeleted: deletedRelations.length,
          },
        },
        tx,
      );

      return {
        id: memoryId,
        embeddingsDeleted: deletedEmbeddings.length,
        stagingEmbeddingsDeleted,
        relationsDeleted: deletedRelations.length,
        proposalsRedacted: relatedProposals.length,
        revisionsRedacted: redactedRevisions.length,
      };
    });
  }
}
