import { Inject, Injectable } from '@nestjs/common';
import { and, arrayOverlaps, desc, eq, ilike, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { ToolError } from '../common/errors';
import { generateId, ID_PREFIX } from '../common/ids';
import { scanForSecrets } from '../common/secret-scanner';
import { AppConfigService } from '../config/config.service';
import { DASHBOARD_ACTOR } from '../dashboard/dashboard.constants';
import { DB, type Database, type Tx } from '../db/db.tokens';
import { embeddings, memories, revisions, type MemoryRow, type RevisionRow } from '../db/schema';
import type { MemoryKind, MemoryScope, MemoryStatus, RevisionAction } from '../db/schema/enums';
import { EmbeddingService } from '../embeddings/embedding.service';
import { normalizeHeader, normalizeTags, validateBody, validateEventTime } from './validation';

export interface ListMemoriesFilter {
  /** `undefined`/`'all'` = brak filtra scope/projectId (FR-D6 "Wszystkie" — dashboard trusted, NFR-1).
   * `'global'` = tylko scope=global. `'project'` (+ `projectId`) = STRICT `scope=project AND
   * project_id=projectId` (bez leakage global, wymóg §9.6 design-systemu). */
  scope?: 'all' | 'global' | 'project';
  projectId?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  tags?: string[];
  q?: string;
  limit?: number;
}

/** Ekran "Oś czasu" (roadmap v1.2, "kind=event episodic") — ten sam kształt scope co
 * `ListMemoriesFilter`, ale `kind='event'` jest wymuszony wewnątrz `listEvents`, nie filtrem
 * wywołującego. */
export interface ListEventsFilter {
  scope?: 'all' | 'global' | 'project';
  projectId?: string;
  limit?: number;
}

export interface MemoryListItem {
  id: string;
  header: string;
  kind: MemoryKind;
  tags: string[];
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  source: string;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Tylko `kind=event` (roadmap v1.2) — null dla fact/document. */
  eventTime: string | null;
}

export interface MemoryDetail extends MemoryListItem {
  body: string;
  approvedAt: string | null;
}

export interface HumanCreateInput {
  kind: MemoryKind;
  header: string;
  body: string;
  tags?: string[];
  scope: MemoryScope;
  projectId?: string | null;
  /** Wymagany gdy `kind='event'` (ISO timestamp, backdatable, przyszłe daty dozwolone) — patrz
   * `validateEventTime`. Ignorowany dla fact/document. */
  eventTime?: string;
}

export interface EditMemoryInput {
  header?: string;
  body?: string;
  tags?: string[];
  /** Korekta backdate po fakcie (roadmap v1.2, "Edycja `event_time` po utworzeniu") — ISO,
   * sens tylko dla `kind='event'`; `editMemory` odrzuca ją twardo dla fact/document zamiast
   * cicho ignorować (maskowałoby bug klienta). */
  eventTime?: string;
}

export interface WithWarnings {
  warnings: string[];
}

function snapshotOf(row: MemoryRow): Record<string, unknown> {
  return { header: row.header, body: row.body, tags: row.tags, kind: row.kind, version: row.version, eventTime: row.eventTime };
}

function toListItem(row: {
  id: string;
  header: string;
  kind: MemoryKind;
  tags: string[];
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  source: string;
  accessCount: number;
  lastAccessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  eventTime: Date | null;
}): MemoryListItem {
  return {
    ...row,
    lastAccessedAt: row.lastAccessedAt ? row.lastAccessedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    eventTime: row.eventTime ? row.eventTime.toISOString() : null,
  };
}

function toDetail(row: MemoryRow): MemoryDetail {
  return {
    ...toListItem(row),
    body: row.body,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
  };
}

/**
 * Operacje przeglądarki pamięci + human-create/edit/archive/promote (FR-D2, FR-D5) — celowo NIE w
 * `MemoryService` (§Ryzyka planu Fazy 5): `MemoryService.get()` jest semantyką MCP (bumpuje
 * `access_count`/`last_accessed_at`, egzekwuje scope tokena) — przeglądarka dashboardu czyta bez
 * scope-gatingu (NFR-1, człowiek zaufany) i BEZ bumpowania licznika dostępu (to feed dla prune, nie
 * dla ludzkiego podglądu). Commit-bezpośredni (`source='human'`, poza kolejką) — mirror
 * `MemoryService.devSeedApproved` + rewizja/audyt, zgodnie z planem.
 */
@Injectable()
export class MemoryAdminService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly embedding: EmbeddingService,
  ) {}

  async listMemories(filter: ListMemoriesFilter = {}): Promise<MemoryListItem[]> {
    const conditions = [];
    if (filter.status) conditions.push(eq(memories.status, filter.status));
    if (filter.kind) conditions.push(eq(memories.kind, filter.kind));
    if (filter.scope === 'global') {
      conditions.push(eq(memories.scope, 'global'));
    } else if (filter.scope === 'project' && filter.projectId) {
      conditions.push(eq(memories.scope, 'project'));
      conditions.push(eq(memories.projectId, filter.projectId));
    }
    if (filter.tags && filter.tags.length > 0) {
      conditions.push(arrayOverlaps(memories.tags, filter.tags));
    }
    const q = filter.q?.trim();
    if (q) {
      conditions.push(ilike(memories.header, `%${q}%`));
    }

    const rows = await this.db
      .select({
        id: memories.id,
        header: memories.header,
        kind: memories.kind,
        tags: memories.tags,
        scope: memories.scope,
        projectId: memories.projectId,
        status: memories.status,
        source: memories.source,
        accessCount: memories.accessCount,
        lastAccessedAt: memories.lastAccessedAt,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
        version: memories.version,
        eventTime: memories.eventTime,
      })
      .from(memories)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(memories.updatedAt))
      .limit(filter.limit ?? 200);

    return rows.map(toListItem);
  }

  /** Ekran "Oś czasu" (roadmap v1.2, "kind=event episodic") — WYŁĄCZNIE `kind='event'` status
   * `approved` (widok kuratorski, nie admin-browse-all — archived/purged nie mają miejsca w
   * chronologii "co się wydarzyło"), sortowane `event_time DESC`. Scope STRICT jak `listMemories`
   * (§9.6 design-systemu) — `project` nigdy nie przecieka global/inny projekt. */
  async listEvents(filter: ListEventsFilter = {}): Promise<MemoryListItem[]> {
    const conditions = [eq(memories.kind, 'event' as const), eq(memories.status, 'approved' as const)];
    if (filter.scope === 'global') {
      conditions.push(eq(memories.scope, 'global'));
    } else if (filter.scope === 'project' && filter.projectId) {
      conditions.push(eq(memories.scope, 'project'));
      conditions.push(eq(memories.projectId, filter.projectId));
    }

    const rows = await this.db
      .select({
        id: memories.id,
        header: memories.header,
        kind: memories.kind,
        tags: memories.tags,
        scope: memories.scope,
        projectId: memories.projectId,
        status: memories.status,
        source: memories.source,
        accessCount: memories.accessCount,
        lastAccessedAt: memories.lastAccessedAt,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
        version: memories.version,
        eventTime: memories.eventTime,
      })
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.eventTime))
      .limit(filter.limit ?? 200);

    return rows.map(toListItem);
  }

  /** Pełny wiersz + metadane, BEZ bumpowania `access_count`/`last_accessed_at` (§Ryzyka planu). */
  async getMemoryDetail(id: string): Promise<MemoryDetail> {
    const [row] = await this.db.select().from(memories).where(eq(memories.id, id)).limit(1);
    if (!row) throw new ToolError('not_found', `Pamięć nie istnieje: ${id}`);
    return toDetail(row);
  }

  async listRevisions(memoryId: string): Promise<RevisionRow[]> {
    return this.db.select().from(revisions).where(eq(revisions.memoryId, memoryId)).orderBy(desc(revisions.createdAt));
  }

  /** Commit bezpośredni (FR-D5) — poza kolejką, `source='human'`. Skaner sekretów WARN-ONLY (FR-S1:
   * human → ostrzeżenie, treść nie blokowana ani nie mutowana), symetrycznie z `ProposalsService.edit`. */
  async humanCreate(input: HumanCreateInput): Promise<{ id: string } & WithWarnings> {
    if (input.scope === 'project' && !input.projectId) {
      throw new ToolError('validation_error', 'projectId jest wymagany dla scope=project');
    }
    const header = normalizeHeader(input.header);
    const body = validateBody(input.body, input.kind, this.config);
    const tags = normalizeTags(input.tags, this.config);
    // `event` (roadmap v1.2, "kind=event episodic") — event_time wymagany, backdatable, przyszłe
    // daty dozwolone bez blokady; null dla fact/document (validateEventTime sam to rozstrzyga).
    const eventTime = validateEventTime(input.eventTime, input.kind);
    const warnings = this.scanWarn(header, body);

    const memoryId = generateId(ID_PREFIX.memory);
    // Embedding POZA transakcją (sieć) — jak `ProposalsService.approve` (§1.5 planu Fazy 4).
    const embedded = await this.embedding.embedMemoryBestEffort(input.kind, header, body, tags);

    await this.db.transaction(async (tx) => {
      await tx.insert(memories).values({
        id: memoryId,
        header,
        body,
        kind: input.kind,
        tags,
        scope: input.scope,
        projectId: input.scope === 'project' ? (input.projectId ?? null) : null,
        status: 'approved',
        source: 'human',
        version: 0,
        approvedAt: new Date(),
        eventTime,
      });
      await this.writeRevision(tx, memoryId, 'created', undefined);
      if (embedded) {
        await tx.insert(embeddings).values(
          embedded.chunks.map((c) => ({
            id: generateId(ID_PREFIX.embedding),
            memoryId,
            chunkIndex: c.index,
            chunkText: c.text,
            embeddingModel: embedded.model,
            vector: c.vector,
          })),
        );
      }
      await this.audit.log(
        {
          eventType: 'human_edit',
          actor: DASHBOARD_ACTOR,
          affectedIds: [memoryId],
          metadata: { action: 'created', kind: input.kind },
        },
        tx,
      );
    });

    return { id: memoryId, warnings };
  }

  async editMemory(id: string, edits: EditMemoryInput): Promise<WithWarnings> {
    const [current] = await this.db.select().from(memories).where(eq(memories.id, id)).limit(1);
    if (!current) throw new ToolError('not_found', `Pamięć nie istnieje: ${id}`);
    if (current.status !== 'approved') {
      throw new ToolError('validation_error', `Pamięć ${id} nie jest w stanie approved (jest: ${current.status})`);
    }
    // `event_time` (roadmap v1.2, "Edycja event_time po utworzeniu") ma sens WYŁĄCZNIE dla
    // kind=event — twardy reject zamiast cichego ignorowania, żeby nie maskować buga klienta.
    if (edits.eventTime !== undefined && current.kind !== 'event') {
      throw new ToolError('validation_error', `event_time można edytować wyłącznie dla kind=event (jest: ${current.kind})`);
    }

    const header = edits.header !== undefined ? normalizeHeader(edits.header) : current.header;
    const body = edits.body !== undefined ? validateBody(edits.body, current.kind, this.config) : current.body;
    const tags = edits.tags !== undefined ? normalizeTags(edits.tags, this.config) : current.tags;
    // Fallback na obecną wartość gdy `eventTime` nie podano — analogicznie do header/body/tags.
    const eventTime = validateEventTime(
      edits.eventTime !== undefined ? edits.eventTime : current.eventTime?.toISOString(),
      current.kind,
    );
    const warnings = this.scanWarn(header, body);

    // Embedding POZA transakcją (sieć) — jak `ProposalsService.approve` (§1.5 planu Fazy 4).
    const embedded = await this.embedding.embedMemoryBestEffort(current.kind, header, body, tags);

    await this.db.transaction(async (tx) => {
      await tx
        .update(memories)
        .set({ header, body, tags, eventTime, version: sql`${memories.version} + 1`, updatedAt: new Date() })
        .where(eq(memories.id, id));
      await this.writeRevision(tx, id, 'edited', snapshotOf(current));
      await tx.delete(embeddings).where(eq(embeddings.memoryId, id));
      if (embedded) {
        await tx.insert(embeddings).values(
          embedded.chunks.map((c) => ({
            id: generateId(ID_PREFIX.embedding),
            memoryId: id,
            chunkIndex: c.index,
            chunkText: c.text,
            embeddingModel: embedded.model,
            vector: c.vector,
          })),
        );
      }
      await this.audit.log(
        { eventType: 'human_edit', actor: DASHBOARD_ACTOR, affectedIds: [id], metadata: { action: 'edited' } },
        tx,
      );
    });

    return { warnings };
  }

  /** Soft-delete (§1.3 planu Fazy 4 — nigdy hard-delete): bump wersji + usunięcie embeddingów
   * (NFR-6, archived nie bierze udziału w search), jak `ProposalsService`'s `archiveMemory`. */
  async archiveMemory(id: string): Promise<void> {
    const current = await this.requireApproved(id, 'archiwizacji');
    await this.db.transaction(async (tx) => {
      await tx
        .update(memories)
        .set({ status: 'archived', version: sql`${memories.version} + 1`, updatedAt: new Date() })
        .where(eq(memories.id, id));
      await tx.delete(embeddings).where(eq(embeddings.memoryId, id));
      await this.writeRevision(tx, id, 'archive', snapshotOf(current));
      await this.audit.log({ eventType: 'archive', actor: DASHBOARD_ACTOR, affectedIds: [id] }, tx);
    });
  }

  async promoteToGlobal(id: string): Promise<void> {
    const [current] = await this.db.select().from(memories).where(eq(memories.id, id)).limit(1);
    if (!current) throw new ToolError('not_found', `Pamięć nie istnieje: ${id}`);
    if (current.scope === 'global') {
      throw new ToolError('validation_error', `Pamięć ${id} jest już scope=global`);
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(memories)
        .set({ scope: 'global', projectId: null, version: sql`${memories.version} + 1`, updatedAt: new Date() })
        .where(eq(memories.id, id));
      await this.writeRevision(tx, id, 'promote', snapshotOf(current));
      await this.audit.log({ eventType: 'promote', actor: DASHBOARD_ACTOR, affectedIds: [id] }, tx);
    });
  }

  // ---- private helpers ------------------------------------------------

  private async requireApproved(id: string, action: string): Promise<MemoryRow> {
    const [current] = await this.db.select().from(memories).where(eq(memories.id, id)).limit(1);
    if (!current) throw new ToolError('not_found', `Pamięć nie istnieje: ${id}`);
    if (current.status !== 'approved') {
      throw new ToolError('validation_error', `Pamięć ${id} nie kwalifikuje się do ${action} (status: ${current.status})`);
    }
    return current;
  }

  private scanWarn(header: string, body: string): string[] {
    const hit = scanForSecrets(`${header}\n${body}`);
    if (!hit) return [];
    return [
      `Wykryto potencjalny sekret (${hit.kind}) w treści — zapisano mimo to (recenzent-human, warn-only, FR-S1).`,
    ];
  }

  private async writeRevision(
    executor: Database | Tx,
    memoryId: string,
    action: RevisionAction,
    snapshot: Record<string, unknown> | undefined,
  ): Promise<void> {
    await executor.insert(revisions).values({
      id: generateId(ID_PREFIX.revision),
      memoryId,
      action,
      actor: DASHBOARD_ACTOR,
      snapshot: snapshot ?? null,
    });
  }

}
