import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { ToolError } from '../common/errors';
import { generateId, ID_PREFIX } from '../common/ids';
import { scanForSecrets } from '../common/secret-scanner';
import { AppConfigService } from '../config/config.service';
import { DB, type Database, type Tx } from '../db/db.tokens';
import { embeddings, memories, memoryRelations, proposals, revisions, stagingEmbeddings } from '../db/schema';
import type {
  MemoryKind,
  MemoryScope,
  MemorySource,
  ProposalOrigin,
  RevisionAction,
} from '../db/schema/enums';
import type { MemoryRelationRow, MemoryRow, ProposalRow } from '../db/schema';
import { EmbeddingService } from '../embeddings/embedding.service';
import { normalizeHeader, normalizeTags, validateBody } from '../memory/validation';
import { ProposalError } from './proposals.errors';
import type {
  ApproveOptions,
  ApproveResult,
  BulkApproveOptions,
  BulkDecisionItemError,
  BulkDecisionResult,
  BulkRejectOptions,
  CreatePayload,
  DeletePayload,
  EditInput,
  EditOptions,
  EditResult,
  EmbeddingDisposition,
  ListProposalsFilter,
  MergePayload,
  ProposalPayload,
  ProposalView,
  RelationPayloadEntry,
  RejectOptions,
  UpdatePayload,
} from './proposals.types';

/** `proposal.origin` i `memory.source` dzielą DOKŁADNIE ten sam zbiór wartości (§4 tech-stack,
 * `db/schema/enums.ts`) — mapowanie 1:1, jawne (nie `origin as unknown as MemorySource`), żeby
 * przyszłe rozjechanie enumów (np. `nightly` → coś innego dla source) rzuciło błędem typów tutaj. */
export const ORIGIN_TO_SOURCE: Record<ProposalOrigin, MemorySource> = {
  agent: 'agent',
  human: 'human',
  nightly: 'nightly',
};

/** Treść w pełni rozwiązana (bez opcjonalnych pól patcha) — wejście do (re)embeddingu i materializacji. */
interface ResolvedContent {
  header: string;
  body: string;
  tags: string[];
  kind: MemoryKind;
}

interface EmbeddingChunkInput {
  chunkIndex: number;
  chunkText: string;
  embeddingModel: string;
  vector: number[] | null;
}

interface EmbeddingPrep {
  disposition: EmbeddingDisposition;
  chunks: EmbeddingChunkInput[];
}

/** `payload.editedPayload ?? payload.payload` — recenzent (edit-before-approve, FR-Q6) wygrywa,
 * gdy obecny; oryginał agenta zostaje nietknięty w `payload` (§1.4 planu). Pure — bez I/O,
 * testowalne jednostkowo (§4.1 planu). */
export function pickEffectivePayload(row: {
  payload: unknown;
  editedPayload: unknown;
}): ProposalPayload {
  return (row.editedPayload ?? row.payload) as ProposalPayload;
}

/** Klasyfikator staleness (§1.2 planu, pkt 4): dla każdego `affectedId` porównuje wersję zamkniętą
 * w `base_versions` proposala z AKTUALNĄ wersją (przekazaną z zewnątrz — czytaną pod lockiem albo,
 * dla samego wyświetlania, bez locka). Brakujący wiersz (purged/gone) liczy się jako stale.
 * Pure — bez I/O, testowalne jednostkowo bez kontenera (§4.1 planu). */
export function computeStaleIds(
  currentVersions: Map<string, number>,
  baseVersions: Record<string, number>,
  affectedIds: string[],
): string[] {
  const staleIds: string[] = [];
  for (const id of affectedIds) {
    const current = currentVersions.get(id);
    if (current === undefined || current !== baseVersions[id]) {
      staleIds.push(id);
    }
  }
  return staleIds;
}

/** Górny limit jednego bulku (roadmap v1.3, "Bulk approve/reject w kolejce"). Twardy cap zamiast
 * paginacji: bulk jest sekwencyjny (patrz `runBulk`), a każdy item może zrobić sieciowy embedding —
 * bez capu jeden klik mógłby trzymać request minutami. */
export const BULK_MAX_IDS = 100;

/** Walidacja + deduplikacja koperty bulku. Bierze `unknown`, bo body z kontrolera to czysta asercja
 * typu TS (brak globalnego `ValidationPipe` w `main.ts`). Duplikaty kolapsują cicho (drugie wystąpienie
 * tego samego id dałoby fałszywy `already_decided`); kolejność pierwszego wystąpienia zachowana.
 * Pure — bez I/O, testowalne jednostkowo (§4.1 planu). */
export function normalizeBulkIds(ids: unknown, max: number = BULK_MAX_IDS): string[] {
  if (!Array.isArray(ids)) {
    throw new ProposalError('validation_error', '`ids` musi być tablicą stringów');
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') {
      throw new ProposalError('validation_error', 'Każdy element `ids` musi być stringiem');
    }
    const id = raw.trim();
    if (id.length === 0) {
      throw new ProposalError('validation_error', 'Element `ids` nie może być pustym stringiem');
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  if (normalized.length === 0) {
    throw new ProposalError('validation_error', '`ids` nie może być puste');
  }
  if (normalized.length > max) {
    throw new ProposalError(
      'validation_error',
      `Maksymalnie ${max} propozycji w jednej operacji zbiorczej (otrzymano ${normalized.length})`,
    );
  }
  return normalized;
}

/** `ProposalError` -> wiersz podsumowania `failed[]`; wszystko inne -> `code:'unknown'` (bez wycieku
 * oryginalnej wiadomości/stack trace'u do klienta — oryginał i tak logowany przez `runBulk` przed
 * wywołaniem tej funkcji). Pure — bez I/O, testowalne jednostkowo (§4.1 planu). */
export function toBulkItemError(id: string, err: unknown): BulkDecisionItemError {
  if (err instanceof ProposalError) {
    return {
      id,
      code: err.code,
      message: err.message,
      ...(err.staleIds ? { staleIds: err.staleIds } : {}),
    };
  }
  return { id, code: 'unknown', message: 'Nieoczekiwany błąd serwera' };
}

function snapshotOf(row: MemoryRow): Record<string, unknown> {
  return { header: row.header, body: row.body, tags: row.tags, kind: row.kind, version: row.version };
}

/**
 * Kolejka akceptacji (§4, §8bis tech-stack; plan Fazy 4) — `approve`/`reject`/`edit` na proposalach
 * zapisanych przez `MemoryService.save()` (create) albo wstawionych bezpośrednio (update/merge/delete
 * — producenci tych typów to Faza 5/6, poza zakresem tego serwisu, który wyłącznie KONSUMUJE kolejkę).
 *
 * `approve()` to jedna transakcja (`db.transaction`) z jawnymi row-lockami (`FOR UPDATE`) — READ
 * COMMITTED (domyślny poziom) wystarcza, bo poprawność bierze się z locków, nie z izolacji
 * snapshotu. Sieciowe wywołania embeddingu ZAWSZE poza transakcją (nigdy pod lockiem, §1.5 planu) —
 * `approve` nigdy nie blokuje się na providerze (NFR-8, fail-open do `embedding: 'vectorless'`).
 *
 * `bulkApprove`/`bulkReject` (roadmap v1.3, "Bulk approve/reject w kolejce") to CZYSTA ORKIESTRACJA
 * nad `approve()`/`reject()` (§`runBulk` niżej) — ani jedna linia tych dwóch metod nie jest zmieniona.
 */
@Injectable()
export class ProposalsService {
  private readonly logger = new Logger(ProposalsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly embedding: EmbeddingService,
  ) {}

  /** Lista do przeglądu (CLI dziś, dashboard w Fazie 5) — `stale` liczone BEZ locka (display-only). */
  async listPending(filter: ListProposalsFilter = {}): Promise<ProposalView[]> {
    const conditions = [eq(proposals.status, filter.status ?? 'pending')];
    if (filter.origin) conditions.push(eq(proposals.origin, filter.origin));
    if (filter.projectId) conditions.push(eq(proposals.projectId, filter.projectId));

    const rows = await this.db
      .select()
      .from(proposals)
      .where(and(...conditions))
      .orderBy(asc(proposals.createdAt));
    return this.toViews(rows);
  }

  async getProposal(id: string): Promise<ProposalView> {
    const [row] = await this.db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    if (!row) throw new ProposalError('not_found', `Proposal nie istnieje: ${id}`);
    const [view] = await this.toViews([row]);
    return view;
  }

  /**
   * Transakcyjny rdzeń (§1.2-1.6 planu). Kolejność: (a) poza transakcją — szybki not_found/already_decided
   * + przygotowanie embeddingu (sieć, NIGDY pod lockiem); (b) w transakcji — lock proposala, ponowna
   * autorytatywna weryfikacja statusu, lock affected memories `ORDER BY id` (deadlock-safe), stale
   * check, aplikacja per `type`, zapis `revisions`/audytu, `status='approved'`.
   */
  async approve(id: string, opts: ApproveOptions): Promise<ApproveResult> {
    const actor = opts.actor;

    const [preRow] = await this.db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    if (!preRow) throw new ProposalError('not_found', `Proposal nie istnieje: ${id}`);
    if (preRow.status !== 'pending') {
      throw new ProposalError(
        'already_decided',
        `Proposal ${id} ma już status ${preRow.status}`,
        undefined,
        preRow.status,
      );
    }
    if (opts.supersedes && preRow.type !== 'create') {
      throw new ProposalError(
        'validation_error',
        '--supersedes jest dozwolony wyłącznie dla proposali typu create',
      );
    }

    // Rozwiązana treść do (re)embeddingu — poza transakcją (sieć). Dla `update` czytamy AKTUALNY
    // wiersz bez locka wyłącznie jako podstawę do embeddingu spekulacyjnego: jeśli coś zmieni
    // wersję między tym odczytem a lockiem w transakcji, stale check niżej i tak odrzuci całość
    // (patrz komentarz przy `assertNotStale` w planie §1.5) — embedding policzony na próżno,
    // nigdy błędnie zaaplikowany.
    const effectivePayload = pickEffectivePayload(preRow);
    let resolved: ResolvedContent | null = null;
    if (preRow.type === 'create' || preRow.type === 'merge') {
      const p = effectivePayload as CreatePayload | MergePayload;
      resolved = { header: p.header, body: p.body, tags: p.tags, kind: p.kind };
    } else if (preRow.type === 'update') {
      const p = effectivePayload as UpdatePayload;
      const [current] = await this.db.select().from(memories).where(eq(memories.id, p.memoryId)).limit(1);
      resolved = {
        header: p.header ?? current?.header ?? '',
        body: p.body ?? current?.body ?? '',
        tags: p.tags ?? current?.tags ?? [],
        kind: p.kind ?? current?.kind ?? 'fact',
      };
    }
    const embeddingPrep = resolved ? await this.prepareEmbeddings(preRow.id, resolved) : null;

    return this.db.transaction(async (tx) => {
      const [propRow] = await tx.select().from(proposals).where(eq(proposals.id, id)).for('update');
      if (!propRow) throw new ProposalError('not_found', `Proposal nie istnieje: ${id}`);
      if (propRow.status !== 'pending') {
        throw new ProposalError(
          'already_decided',
          `Proposal ${id} ma już status ${propRow.status}`,
          undefined,
          propRow.status,
        );
      }

      const payload = pickEffectivePayload(propRow);
      const affectedIds = [...propRow.affectedIds];
      const supersedeId = opts.supersedes;
      // Deterministyczna kolejność locków (ORDER BY id) — zapobiega deadlockom między nakładającymi
      // się proposalami (§1.2 pkt 3 planu).
      const lockIds = Array.from(new Set(supersedeId ? [...affectedIds, supersedeId] : affectedIds)).sort();

      const lockedRows =
        lockIds.length > 0
          ? await tx
              .select()
              .from(memories)
              .where(inArray(memories.id, lockIds))
              .orderBy(asc(memories.id))
              .for('update')
          : [];
      const byId = new Map(lockedRows.map((r) => [r.id, r]));

      if (affectedIds.length > 0) {
        const baseVersions = (propRow.baseVersions ?? {}) as Record<string, number>;
        const currentVersions = new Map(lockedRows.map((r) => [r.id, r.version]));
        this.assertNotStale(currentVersions, baseVersions, affectedIds);
      }

      let supersedeRow: MemoryRow | undefined;
      if (supersedeId) {
        supersedeRow = byId.get(supersedeId);
        if (!supersedeRow) {
          throw new ProposalError('stale', `Pamięć do supersede nie istnieje: ${supersedeId}`, [
            supersedeId,
          ]);
        }
        if (
          opts.expectedSupersedeVersion !== undefined &&
          supersedeRow.version !== opts.expectedSupersedeVersion
        ) {
          throw new ProposalError('stale', `Pamięć do supersede jest nieaktualna: ${supersedeId}`, [
            supersedeId,
          ]);
        }
      }

      const archivedIds: string[] = [];
      let materializedId: string | undefined;
      let embeddingDisposition: EmbeddingDisposition = 'vectorless';

      switch (propRow.type) {
        case 'create': {
          const createPayload = payload as CreatePayload;
          const created = await this.materializeMemory(tx, createPayload, {
            scope: propRow.scope,
            projectId: propRow.projectId,
            origin: propRow.origin,
          });
          materializedId = created.id;
          await this.writeRevision(tx, {
            memoryId: created.id,
            action: 'created',
            actor,
            supersedes: supersedeRow?.id,
          });
          if (embeddingPrep) {
            await this.applyEmbeddings(tx, created.id, embeddingPrep, true);
            embeddingDisposition = embeddingPrep.disposition;
          }
          if (supersedeRow) {
            await this.archiveMemory(tx, supersedeRow, actor);
            await this.writeRevision(tx, {
              memoryId: supersedeRow.id,
              action: 'superseded_by',
              actor,
              snapshot: snapshotOf(supersedeRow),
              supersededBy: created.id,
            });
            archivedIds.push(supersedeRow.id);
          }
          // Attach-on-save (roadmap v1.2) — materializacja PO wszystkim innym (embeddingi, ewentualne
          // supersede-archive), symetrycznie z kolejnością reszty efektów ubocznych `create`.
          await this.materializeRelations(tx, created.id, propRow.projectId, createPayload.relations, actor);
          break;
        }
        case 'update': {
          const updatePayload = payload as UpdatePayload;
          const target = byId.get(updatePayload.memoryId);
          if (!target) {
            throw new ProposalError('stale', `Pamięć nie istnieje: ${updatePayload.memoryId}`, [
              updatePayload.memoryId,
            ]);
          }
          const snapshot = snapshotOf(target);
          await tx
            .update(memories)
            .set({
              header: updatePayload.header ?? target.header,
              body: updatePayload.body ?? target.body,
              tags: updatePayload.tags ?? target.tags,
              kind: updatePayload.kind ?? target.kind,
              version: sql`${memories.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(memories.id, target.id));
          await this.writeRevision(tx, { memoryId: target.id, action: 'edited', actor, snapshot });
          if (embeddingPrep) {
            await this.applyEmbeddings(tx, target.id, embeddingPrep, false);
            embeddingDisposition = embeddingPrep.disposition;
          }
          // Attach-on-save (roadmap v1.2) — `saveAsSupersede` niesie krawędzie OD targetu (self=targetId),
          // materializowane tu, tak samo jak dla `create`.
          await this.materializeRelations(tx, target.id, propRow.projectId, updatePayload.relations, actor);
          materializedId = target.id;
          break;
        }
        case 'merge': {
          const mergePayload = payload as MergePayload;
          const created = await this.materializeMemory(tx, mergePayload, {
            scope: propRow.scope,
            projectId: propRow.projectId,
            origin: propRow.origin,
          });
          materializedId = created.id;
          // C dostaje DOKŁADNIE jedną rewizję `created` (kolumny supersedes/superseded_by są
          // jednowartościowe — nie da się nimi wyrazić N archiwizowanych na jednym wierszu C).
          // Kierunek "co zastąpiło co" żyje symetrycznie po stronie każdego archiwizowanego (niżej).
          await this.writeRevision(tx, { memoryId: created.id, action: 'created', actor });
          if (embeddingPrep) {
            await this.applyEmbeddings(tx, created.id, embeddingPrep, true);
            embeddingDisposition = embeddingPrep.disposition;
          }

          // Repin krawędzi scalanych pamięci NA C — MUSI być odczytane PRZED pętlą `archiveMemory`
          // niżej, bo `archiveMemory` kasuje (i audytuje jako `relation_removed`) wszystkie krawędzie
          // dotykające archiwizowanego wiersza. Bez tego snapshotu C dziedziczyłaby zero krawędzi,
          // mimo że A/B je miały (code review finding "merge niszczy graf", roadmap v1.2).
          const edgesToRepin: MemoryRelationRow[] =
            affectedIds.length > 0
              ? await tx
                  .select()
                  .from(memoryRelations)
                  .where(
                    or(
                      inArray(memoryRelations.fromMemoryId, affectedIds),
                      inArray(memoryRelations.toMemoryId, affectedIds),
                    ),
                  )
              : [];

          for (const archivedId of affectedIds) {
            const row = byId.get(archivedId);
            if (!row) continue; // niemożliwe po assertNotStale — strażnik dla typechecka
            await this.archiveMemory(tx, row, actor);
            await this.writeRevision(tx, {
              memoryId: row.id,
              action: 'superseded_by',
              actor,
              snapshot: snapshotOf(row),
              supersededBy: created.id,
            });
            archivedIds.push(row.id);
          }

          await this.repinRelationsToSurvivor(
            tx,
            edgesToRepin,
            new Set(affectedIds),
            created.id,
            propRow.projectId,
            actor,
          );
          break;
        }
        case 'delete': {
          const deletePayload = payload as DeletePayload;
          const target = byId.get(deletePayload.memoryId);
          if (!target) {
            throw new ProposalError('stale', `Pamięć nie istnieje: ${deletePayload.memoryId}`, [
              deletePayload.memoryId,
            ]);
          }
          await this.archiveMemory(tx, target, actor);
          await this.writeRevision(tx, {
            memoryId: target.id,
            action: 'archive',
            actor,
            snapshot: snapshotOf(target),
          });
          archivedIds.push(target.id);
          break;
        }
      }

      // Staging żyje 1:1 z proposalem — po materializacji (albo próbie, dla delete i tak zawsze pusty)
      // nie ma już czego promować; sprzątamy niezależnie od dyspozycji embeddingu.
      await tx.delete(stagingEmbeddings).where(eq(stagingEmbeddings.proposalId, propRow.id));
      await tx.update(proposals).set({ status: 'approved', updatedAt: new Date() }).where(eq(proposals.id, id));

      await this.audit.log(
        {
          eventType: 'proposal_approved',
          actor,
          affectedIds: materializedId ? [materializedId, ...archivedIds] : archivedIds,
          metadata: {
            proposalId: id,
            type: propRow.type,
            ...(supersedeRow ? { supersededId: supersedeRow.id } : {}),
          },
        },
        tx,
      );

      return { proposalId: id, materializedId, archivedIds, embedding: embeddingDisposition };
    });
  }

  /** Bez mutacji pamięci — samo zamknięcie proposala (§1.6 planu). Retencja wiersza dla ekranu
   * audytu (FR-D4), więc `status='rejected'`, nie hard-delete. */
  async reject(id: string, opts: RejectOptions): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(proposals).where(eq(proposals.id, id)).for('update');
      if (!row) throw new ProposalError('not_found', `Proposal nie istnieje: ${id}`);
      if (row.status !== 'pending') {
        throw new ProposalError(
          'already_decided',
          `Proposal ${id} ma już status ${row.status}`,
          undefined,
          row.status,
        );
      }
      await tx.update(proposals).set({ status: 'rejected', updatedAt: new Date() }).where(eq(proposals.id, id));
      await tx.delete(stagingEmbeddings).where(eq(stagingEmbeddings.proposalId, id));
      await this.audit.log(
        {
          eventType: 'proposal_rejected',
          actor: opts.actor,
          affectedIds: row.affectedIds,
          metadata: { proposalId: id, reason: opts.reason ?? null },
        },
        tx,
      );
    });
  }

  /**
   * Edit-before-approve (FR-Q6, §1.4 planu). Waliduje przez te same pure helpery co `save()`
   * (`memory/validation.ts`) — błędy `ToolError` przepakowane w `ProposalError('validation_error')`.
   * Skaner sekretów przy human-edit jest WARN-ONLY (FR-S1: „human → ostrzeżenie, treść nie
   * mutowana") — w przeciwieństwie do blokady przy agent-save w `MemoryService.save()`.
   */
  async edit(id: string, edits: EditInput, opts: EditOptions): Promise<EditResult> {
    const [preRow] = await this.db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    if (!preRow) throw new ProposalError('not_found', `Proposal nie istnieje: ${id}`);
    if (preRow.status !== 'pending') {
      throw new ProposalError(
        'already_decided',
        `Proposal ${id} ma już status ${preRow.status}`,
        undefined,
        preRow.status,
      );
    }
    if (preRow.type === 'delete') {
      throw new ProposalError('validation_error', 'Proposal typu delete nie ma treści do edycji');
    }

    const base = pickEffectivePayload(preRow) as CreatePayload | UpdatePayload | MergePayload;
    // `kind` jest opcjonalny WYŁĄCZNIE na UpdatePayload (patch); brak = "bez zmian" i domyślnie
    // liczymy limit body jak dla `fact`. Uproszczenie świadome, nie próbujemy tu odgadywać kind
    // aktualnego wiersza (wymagałoby dodatkowego odczytu poza scope edit()). `base.kind` jest
    // WYMAGANE na `CreatePayload` (więc obecne dla proposali `event` od roadmap v1.3 "kind=event
    // przez agenta" tak samo jak dla `fact`/`document`) — recenzent edytujący body eventu przed
    // approve dostaje poprawny `BODY_MAX_EVENT`, nie `BODY_MAX_FACT`. `EditInput` NIE niesie
    // `eventTime` — recenzent chcący zmienić datę odrzuca propozycję albo zatwierdza i poprawia w
    // przeglądarce pamięci (`MemoryAdminService.editMemory` to umie).
    const kind: MemoryKind = 'kind' in base && base.kind ? base.kind : 'fact';

    let header = base.header;
    let body = base.body;
    let tags = base.tags;
    try {
      if (edits.header !== undefined) header = normalizeHeader(edits.header);
      if (edits.body !== undefined) body = validateBody(edits.body, kind, this.config);
      if (edits.tags !== undefined) tags = normalizeTags(edits.tags, this.config);
    } catch (err) {
      if (err instanceof ToolError) {
        throw new ProposalError('validation_error', err.message);
      }
      throw err;
    }

    const warnings: string[] = [];
    const hit = scanForSecrets(`${header ?? ''}\n${body ?? ''}`);
    if (hit) {
      warnings.push(
        `Wykryto potencjalny sekret (${hit.kind}) w edytowanej treści — zapisano mimo to ` +
          '(recenzent-human, warn-only, FR-S1).',
      );
    }

    // `...base` (nie pola po polu) — zachowuje `relations` z oryginalnego payloadu bez zmian
    // (roadmap v1.2, attach-on-save): recenzent edytuje treść, nie edytuje krawędzi tutaj.
    const editedPayload: ProposalPayload = { ...base, header, body, tags };

    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(proposals).where(eq(proposals.id, id)).for('update');
      if (!locked) throw new ProposalError('not_found', `Proposal nie istnieje: ${id}`);
      if (locked.status !== 'pending') {
        throw new ProposalError(
          'already_decided',
          `Proposal ${id} ma już status ${locked.status}`,
          undefined,
          locked.status,
        );
      }
      await tx.update(proposals).set({ editedPayload, updatedAt: new Date() }).where(eq(proposals.id, id));
      // Staging był policzony względem ORYGINALNEJ treści agenta — po edycji jest nieaktualny.
      // Usunięcie wymusza gałąź "staging absent -> recompute" w approve() (§1.4 planu).
      await tx.delete(stagingEmbeddings).where(eq(stagingEmbeddings.proposalId, id));
      await this.audit.log(
        {
          eventType: 'proposal_edited',
          actor: opts.actor,
          affectedIds: locked.affectedIds,
          metadata: { proposalId: id, warningCount: warnings.length },
        },
        tx,
      );
    });

    return { warnings };
  }

  /** Bulk approve (roadmap v1.3) — patrz doc-komentarz `runBulk` niżej dla semantyki non-atomowości. */
  async bulkApprove(ids: unknown, opts: BulkApproveOptions): Promise<BulkDecisionResult> {
    return this.runBulk(ids, (id) => this.approve(id, { actor: opts.actor }));
  }

  /** Bulk reject (roadmap v1.3) — `opts.reason` jeden, wspólny dla WSZYSTKICH itemów (decyzja
   * produktowa: bulk reject nie ma per-item uzasadnienia, tylko jeden powód dla całego zestawu). */
  async bulkReject(ids: unknown, opts: BulkRejectOptions): Promise<BulkDecisionResult> {
    return this.runBulk(ids, (id) => this.reject(id, { actor: opts.actor, reason: opts.reason }));
  }

  /**
   * Rdzeń bulku (roadmap v1.3, "Bulk approve/reject w kolejce") — pętla SEKWENCYJNA, NIE
   * `Promise.all`: (1) `approve()` bierze `FOR UPDATE` na `memories` posortowane po id — równoległe
   * itemy z nakładającymi się `affectedIds` byłyby gwarantowaną kontencją locków w obrębie jednego
   * requestu; (2) każdy item może zrobić sieciowy embedding — równoległość byłaby spike'iem na
   * sidecarze; (3) sekwencyjność czyni `succeeded[]` deterministyczne i testowalne.
   *
   * NIE jest atomowy (świadomie, §1 planu — sprzeczne z częściowym sukcesem jako decyzją produktową):
   * itemy zatwierdzone/odrzucone PRZED pierwszym błędem zostają zatwierdzone/odrzucone, błąd kolejnego
   * itemu nie cofa nic z tego, co już się wykonało. Każdy item nadal ma własną transakcję i własny
   * wpis audytu (`approve`/`reject` nietknięte) — to dosłownie ten sam kontrakt co N pojedynczych
   * decyzji z rzędu, tylko wywołanych z jednego requestu.
   */
  private async runBulk(
    ids: unknown,
    run: (id: string) => Promise<unknown>,
  ): Promise<BulkDecisionResult> {
    const normalized = normalizeBulkIds(ids); // rzuca validation_error -> 400, PRZED jakąkolwiek mutacją
    const succeeded: string[] = [];
    const failed: BulkDecisionItemError[] = [];
    for (const id of normalized) {
      // SEKWENCYJNIE — patrz doc-komentarz metody.
      try {
        await run(id);
        succeeded.push(id);
      } catch (err) {
        if (!(err instanceof ProposalError)) {
          this.logger.error(`bulk: nieoczekiwany błąd dla ${id}`, err as Error);
        }
        failed.push(toBulkItemError(id, err));
      }
    }
    return { succeeded, failed };
  }

  // ---- private helpers ------------------------------------------------

  private async toViews(rows: ProposalRow[]): Promise<ProposalView[]> {
    const allAffectedIds = Array.from(new Set(rows.flatMap((r) => r.affectedIds)));
    const versionRows =
      allAffectedIds.length > 0
        ? await this.db
            .select({ id: memories.id, version: memories.version })
            .from(memories)
            .where(inArray(memories.id, allAffectedIds))
        : [];
    const versionMap = new Map(versionRows.map((r) => [r.id, r.version]));

    return rows.map((row) => {
      const baseVersions = (row.baseVersions ?? {}) as Record<string, number>;
      const staleIds = computeStaleIds(versionMap, baseVersions, row.affectedIds);
      return {
        id: row.id,
        type: row.type,
        origin: row.origin,
        status: row.status,
        payload: row.payload as ProposalPayload,
        editedPayload: (row.editedPayload as ProposalPayload | null) ?? null,
        affectedIds: row.affectedIds,
        baseVersions,
        scope: row.scope,
        projectId: row.projectId,
        contentHash: row.contentHash,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        stale: staleIds.length > 0,
        staleIds,
      };
    });
  }

  private assertNotStale(
    currentVersions: Map<string, number>,
    baseVersions: Record<string, number>,
    affectedIds: string[],
  ): void {
    const staleIds = computeStaleIds(currentVersions, baseVersions, affectedIds);
    if (staleIds.length > 0) {
      throw new ProposalError(
        'stale',
        `Proposal jest nieaktualny względem: ${staleIds.join(', ')} (zmienione/usunięte od czasu ` +
          'utworzenia propozycji)',
        staleIds,
      );
    }
  }

  private async materializeMemory(
    tx: Tx,
    payload: CreatePayload | MergePayload,
    ctx: { scope: MemoryScope; projectId: string | null; origin: ProposalOrigin },
  ): Promise<MemoryRow> {
    const [row] = await tx
      .insert(memories)
      .values({
        id: payload.memoryId,
        header: payload.header,
        body: payload.body,
        kind: payload.kind,
        tags: payload.tags,
        scope: ctx.scope,
        projectId: ctx.scope === 'project' ? ctx.projectId : null,
        status: 'approved',
        source: ORIGIN_TO_SOURCE[ctx.origin],
        version: 0,
        approvedAt: new Date(),
        // Tylko `kind='event'` (roadmap v1.3, "kind=event przez agenta") — `CreatePayload.eventTime`
        // niesie ISO string (jsonb), `MergePayload` nigdy nie ma tego pola (nocny job produkuje
        // wyłącznie `kind='fact'`, `nightly.service.ts`), stąd `in` zamiast optional chaining.
        eventTime: 'eventTime' in payload && payload.eventTime ? new Date(payload.eventTime) : null,
      })
      .returning();
    return row;
  }

  /**
   * Attach-on-save materializacja (roadmap v1.2, "memory-relations + 1-hop graph boost") — WYŁĄCZNIE
   * tutaj, wewnątrz `approve()`, nigdy w `MemoryService.save()` (§4 planu, human-gate integrity:
   * krawędzie agenta powstają dopiero po zatwierdzeniu, tak samo jak reszta treści).
   *
   * Fail-open per krawędź (NIE per proposal): cel mógł zniknąć/zmienić stan między `save()` (gdzie
   * `resolveRelations` go zwalidował) a `approve()` — zarchiwizowany, wypromowany do global, albo (w
   * teorii, memories nigdy hard-delete) usunięty. Taka krawędź jest po prostu POMIJANA, NIE blokuje
   * całej akceptacji (relacje nie są w `assertNotStale`/`base_versions` — nie mają własnej wersji, a
   * odrzucenie approve z powodu jednej martwej krawędzi byłoby nieproporcjonalne). `onConflictDoNothing`
   * na `UNIQUE(from,to,type)` — idempotentne, gdyby ta sama krawędź już istniała (np. dodana ręcznie
   * w dashboardzie między save a approve).
   */
  private async materializeRelations(
    tx: Tx,
    fromId: string,
    projectId: string | null,
    relations: RelationPayloadEntry[] | undefined,
    actor: string,
  ): Promise<void> {
    // `projectId` null tylko dla scope=global proposali — `resolveRelations` po stronie
    // `MemoryService` nigdy nie dopuszcza relations na takich (agent-save jest zawsze project-scoped,
    // FR-M4), ale strażnik typu zamiast zakładania.
    if (!relations || relations.length === 0 || !projectId) return;

    const targetIds = Array.from(new Set(relations.map((r) => r.targetId)));
    const targetRows = await tx.select().from(memories).where(inArray(memories.id, targetIds));
    const byId = new Map(targetRows.map((r) => [r.id, r]));

    for (const rel of relations) {
      const target = byId.get(rel.targetId);
      if (
        !target ||
        target.status !== 'approved' ||
        target.scope !== 'project' ||
        target.projectId !== projectId ||
        target.id === fromId
      ) {
        continue; // fail-open — patrz komentarz metody
      }

      const [inserted] = await tx
        .insert(memoryRelations)
        .values({
          id: generateId(ID_PREFIX.relation),
          fromMemoryId: fromId,
          toMemoryId: rel.targetId,
          type: rel.type,
          projectId,
          source: 'agent',
        })
        .onConflictDoNothing()
        .returning({ id: memoryRelations.id });

      if (inserted) {
        await this.audit.log(
          {
            eventType: 'relation_created',
            actor,
            affectedIds: [fromId, rel.targetId],
            metadata: {
              relationId: inserted.id,
              type: rel.type,
              fromMemoryId: fromId,
              toMemoryId: rel.targetId,
              via: 'agent',
            },
          },
          tx,
        );
      }
    }
  }

  /**
   * Merge repina krawędzie scalanych pamięci (A, B, …) NA nowo powstałą C (code review finding
   * "merge niszczy graf", roadmap v1.2) — wołane PO pętli `archiveMemory` w `case 'merge'`, ale na
   * snapshocie krawędzi odczytanym PRZED nią (`archiveMemory` je już skasowała + zaudytowała jako
   * `relation_removed`, patrz komentarz tamże). Zasady:
   * - `X → A` staje się `X → C`, `A → X` staje się `C → X` (kierunek zachowany, `type`/`source`
   *   przepisane z krawędzi źródłowej).
   * - Krawędź WEWNĄTRZ zbioru scalanego (oba końce w `archivedIds`, np. `A → B`) jest POMIJANA —
   *   po przepięciu byłaby self-loopem `C → C`, co łamie `CHECK memory_relations_no_self_loop`
   *   (§db/schema/memory-relations.ts). Ta krawędź i tak zniknęła (audytowana jako `relation_removed`
   *   przez `archiveMemory`), tu po prostu nie ma jej odpowiednika na C.
   * - `onConflictDoNothing` na `UNIQUE(from,to,type)` — dwie krawędzie tego samego typu do tego
   *   samego targetu (np. `A→X` i `B→X`) kolapsują się do jednej `C→X`, tak samo jak w
   *   `materializeRelations` wyżej.
   * `via: 'merge'` w audycie — odróżnia przepięcie przy scaleniu od nowej krawędzi agenta
   * (`materializeRelations`, `via: 'agent'`) albo ręcznej z dashboardu (`via: 'human'`).
   */
  private async repinRelationsToSurvivor(
    tx: Tx,
    edges: MemoryRelationRow[],
    archivedIds: Set<string>,
    survivorId: string,
    projectId: string | null,
    actor: string,
  ): Promise<void> {
    if (edges.length === 0 || !projectId) return;

    for (const edge of edges) {
      const fromArchived = archivedIds.has(edge.fromMemoryId);
      const toArchived = archivedIds.has(edge.toMemoryId);
      if (fromArchived && toArchived) continue; // wewnątrz zbioru scalanego -> pomiń (self-loop guard)

      const newFrom = fromArchived ? survivorId : edge.fromMemoryId;
      const newTo = toArchived ? survivorId : edge.toMemoryId;

      const [inserted] = await tx
        .insert(memoryRelations)
        .values({
          id: generateId(ID_PREFIX.relation),
          fromMemoryId: newFrom,
          toMemoryId: newTo,
          type: edge.type,
          projectId,
          source: edge.source,
        })
        .onConflictDoNothing()
        .returning({ id: memoryRelations.id });

      if (inserted) {
        await this.audit.log(
          {
            eventType: 'relation_created',
            actor,
            affectedIds: [newFrom, newTo],
            metadata: {
              relationId: inserted.id,
              type: edge.type,
              fromMemoryId: newFrom,
              toMemoryId: newTo,
              via: 'merge',
            },
          },
          tx,
        );
      }
    }
  }

  /**
   * Archiwizacja miękka (§1.3 planu — nigdy hard-delete, to osobne CLI purge): bump wersji +
   * usunięcie authoritative embeddingów (NFR-6, archived nie bierze udziału w search) + usunięcie
   * krawędzi grafu (roadmap v1.2), audytowane per-krawędź jako `relation_removed` (code review
   * finding "kaskada bez audytu" — bez tego krawędzie znikały bez śladu w append-only audycie).
   *
   * UWAGA na uzasadnienie: to NIE jest ochrona przed graph boostem ("archived memory nie powinna
   * dalej boostować/być boostowana" — poprzednie, mylące uzasadnienie). Boost widzi WYŁĄCZNIE
   * `fusedIds`, czyli kandydatów z `search()` (`memory.service.ts`), a oba ramiona (`ftsArm`,
   * `findAnnNeighbors`/`vectorArm`) filtrują `status='approved'` — zarchiwizowana pamięć nigdy nie
   * jest kandydatem, więc boost i tak by nie strzelił. Prawdziwy powód: krawędź do pamięci wyjętej
   * z grafu projektu jest martwą daną — `listRelations` w dashboardzie i tak by ją pokazywał jako
   * relację do martwego wiersza. Usunięcie jest teraz audytowane, więc utrata jest widoczna w
   * historii, zamiast znikać po cichu (mirror embeddings; `ON DELETE CASCADE` na
   * `memory_relations` jest tylko belt-and-suspenders dla hard-delete, którego v1 nie robi —
   * status='archived' NIE usuwa wiersza `memories`).
   */
  private async archiveMemory(tx: Tx, row: MemoryRow, actor: string): Promise<void> {
    await tx
      .update(memories)
      .set({ status: 'archived', version: sql`${memories.version} + 1`, updatedAt: new Date() })
      .where(eq(memories.id, row.id));
    await tx.delete(embeddings).where(eq(embeddings.memoryId, row.id));
    const deletedRelations = await tx
      .delete(memoryRelations)
      .where(or(eq(memoryRelations.fromMemoryId, row.id), eq(memoryRelations.toMemoryId, row.id)))
      .returning();
    for (const rel of deletedRelations) {
      await this.audit.log(
        {
          eventType: 'relation_removed',
          actor,
          affectedIds: [rel.fromMemoryId, rel.toMemoryId],
          metadata: {
            relationId: rel.id,
            type: rel.type,
            fromMemoryId: rel.fromMemoryId,
            toMemoryId: rel.toMemoryId,
            // Kaskada z archiwizacji (case 'merge'/'delete'/supersedes), NIE ręczne usunięcie z
            // dashboardu (`MemoryAdminService.removeRelation`, `via: 'human'`) — rozróżnialne w audycie.
            via: 'archive-cascade',
          },
        },
        tx,
      );
    }
  }

  private async writeRevision(
    tx: Tx,
    input: {
      memoryId: string;
      action: RevisionAction;
      actor: string;
      snapshot?: Record<string, unknown>;
      supersedes?: string;
      supersededBy?: string;
    },
  ): Promise<void> {
    await tx.insert(revisions).values({
      id: generateId(ID_PREFIX.revision),
      memoryId: input.memoryId,
      action: input.action,
      actor: input.actor,
      snapshot: input.snapshot ?? null,
      supersedes: input.supersedes ?? null,
      supersededBy: input.supersededBy ?? null,
    });
  }

  /**
   * Przygotowanie embeddingu POZA transakcją (§1.5 planu — nigdy sieć pod lockiem):
   * - staging obecny i pod aktywnym modelem -> `promoted` (kopia w `applyEmbeddings`, czysty SQL).
   * - inaczej -> `embedMemoryBestEffort` (fail-open): chunki -> `recomputed`; `null` -> `vectorless`
   *   (materializacja i tak przechodzi, memory zostaje bez wektorów do czasu `reembed`, NFR-8).
   */
  private async prepareEmbeddings(proposalId: string, resolved: ResolvedContent): Promise<EmbeddingPrep> {
    const staged = await this.db
      .select()
      .from(stagingEmbeddings)
      .where(eq(stagingEmbeddings.proposalId, proposalId));

    if (staged.length > 0 && staged[0].embeddingModel === this.embedding.model) {
      return {
        disposition: 'promoted',
        chunks: staged.map((s) => ({
          chunkIndex: s.chunkIndex,
          chunkText: s.chunkText,
          embeddingModel: s.embeddingModel,
          vector: s.vector,
        })),
      };
    }

    const computed = await this.embedding.embedMemoryBestEffort(
      resolved.kind,
      resolved.header,
      resolved.body,
      resolved.tags,
    );
    if (!computed) {
      return { disposition: 'vectorless', chunks: [] };
    }
    return {
      disposition: 'recomputed',
      chunks: computed.chunks.map((c) => ({
        chunkIndex: c.index,
        chunkText: c.text,
        embeddingModel: computed.model,
        vector: c.vector,
      })),
    };
  }

  /** Aplikacja W transakcji — czysty SQL, żadnej sieci. `isNewMemory=false` (update) najpierw
   * usuwa stare wiersze (delete-then-insert, jak `reembed.command.ts:90-100`) — memory już MA
   * embeddingi ze starej treści, których nie da się po prostu dopisać. */
  private async applyEmbeddings(
    tx: Tx,
    memoryId: string,
    prep: EmbeddingPrep,
    isNewMemory: boolean,
  ): Promise<void> {
    if (!isNewMemory) {
      await tx.delete(embeddings).where(eq(embeddings.memoryId, memoryId));
    }
    if (prep.chunks.length === 0) return;
    await tx.insert(embeddings).values(
      prep.chunks.map((c) => ({
        id: generateId(ID_PREFIX.embedding),
        memoryId,
        chunkIndex: c.chunkIndex,
        chunkText: c.chunkText,
        embeddingModel: c.embeddingModel,
        vector: c.vector,
      })),
    );
  }
}
