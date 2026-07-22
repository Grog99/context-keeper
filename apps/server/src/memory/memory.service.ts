import { Inject, Injectable } from '@nestjs/common';
import { and, arrayOverlaps, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { computeContentHash } from '../common/content-hash';
import { ToolError } from '../common/errors';
import { generateId, ID_PREFIX } from '../common/ids';
import { scanForSecrets } from '../common/secret-scanner';
import { AppConfigService } from '../config/config.service';
import { DB, type Database } from '../db/db.tokens';
import { embeddings, memories, proposals, stagingEmbeddings, type MemoryRow } from '../db/schema';
import { findAnnNeighbors } from '../embeddings/ann-search';
import { EmbeddingService, toPgVectorLiteral } from '../embeddings/embedding.service';
import type { ProjectContext } from '../projects/projects.service';
import { classifyDedup } from './dedup';
import type {
  GetMemoryResult,
  MemoryKindFilter,
  SaveMemoryInput,
  SaveMemoryResult,
  SearchMemoryInput,
  SearchResultItem,
  SeedApprovedInput,
} from './memory.types';
import { normalizeHeader, normalizeTags, validateBody } from './validation';
import { rrfFuse } from './rrf';

const DEFAULT_SEARCH_KINDS: MemoryKindFilter[] = ['fact', 'document'];
// Fragment chunku dopasowanego wektorowo, dołączany do wyniku search dla kind=document (FR-M1).
const EXCERPT_MAX_LEN = 280;

/**
 * Warstwa logiki pamięci (§4-6 tech-stack) — reużywalna później przez kolejkę akceptacji (Faza 4)
 * i dashboard (Faza 5). Save → proposal (+ best-effort staged embedding, Faza 3), search → hybryda
 * FTS+wektor fuzjowana RRF (fail-open do FTS-only przy embedding-down), get → approved w scope
 * + bump technicznego licznika.
 */
@Injectable()
export class MemoryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly embedding: EmbeddingService,
  ) {}

  /**
   * save_memory (FR-M3-M5, FR-S1, FR-V1). Agent zapisuje WYŁĄCZNIE `kind=fact`, `scope=project`
   * (dokumenty i `global` to human-only, poza MCP w v1 — stąd brak parametru `kind` w sygnaturze).
   */
  async save(input: SaveMemoryInput, ctx: ProjectContext): Promise<SaveMemoryResult> {
    const header = normalizeHeader(input.header);
    const body = validateBody(input.body, 'fact', this.config);
    const tags = normalizeTags(input.tags, this.config);
    const actor = `agent:${ctx.projectId}`;

    // Skaner sekretów (§10, FR-S1): agent-save → blokada, materiał nigdy nie dotyka bazy.
    const hit = scanForSecrets(`${header}\n${body}`);
    if (hit) {
      await this.audit.log({
        eventType: 'secret_blocked',
        actor,
        metadata: { secretType: hit.kind }, // BEZ materiału sekretu (§10)
      });
      throw new ToolError(
        'secret_blocked',
        'Wykryto potencjalny sekret w treści — zapis zablokowany. Usuń materiał sekretu ' +
          '(referuj po nazwie/przeznaczeniu, nigdy po wartości) i spróbuj ponownie.',
      );
    }

    const scope = 'project' as const; // FR-M4: zapisy agenta tylko project-scoped
    const contentHash = computeContentHash({ header, body, scope, projectId: ctx.projectId });

    // Idempotencja (FR-M8): exact match do pending proposala w tym samym projekcie → duplicate_pending.
    const [pendingDup] = await this.db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.contentHash, contentHash),
          eq(proposals.status, 'pending'),
          eq(proposals.projectId, ctx.projectId),
        ),
      )
      .limit(1);

    // Exact match do zatwierdzonej pamięci → already_exists. Bez osobnej kolumny hash na `memories`
    // (Faza 1 jej nie definiuje) — porównanie polowe jest semantycznie równoważne
    // hash(header+body+scope+project), więc nie modyfikujemy schematu Fazy 1 dla tego.
    // Pomijamy to zapytanie, jeśli pending już wygrał (klasyfikacja i tak go zignoruje).
    let existingMemory: { id: string } | undefined;
    if (!pendingDup) {
      [existingMemory] = await this.db
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.status, 'approved'),
            eq(memories.scope, scope),
            eq(memories.projectId, ctx.projectId),
            eq(memories.header, header),
            eq(memories.body, body),
          ),
        )
        .limit(1);
    }

    const outcome = classifyDedup(pendingDup ?? null, existingMemory ?? null);
    if (outcome.status !== 'pending') {
      // duplicate_pending → id proposala; already_exists → id pamięci (§5 tech-stack, dosłownie).
      return { id: outcome.existingId!, status: outcome.status };
    }

    // Faza 4 seam: staged wektor (zapisywany niżej, best-effort) czeka na PROMOCJĘ do `embeddings`
    // przy akceptacji proposala — promocja żyje w `ProposalsService.approve` (Faza 4), NIE tutaj.
    // FR-M3 hint "podobne do" wciąż nie jest zbudowany (poza zakresem Fazy 4) — dzisiejszy staged
    // wektor to tylko dedup-hint na przyszłość, nieużywany jeszcze przy klasyfikacji create/duplicate.
    const mintedMemoryId = generateId(ID_PREFIX.memory);
    const proposalId = generateId(ID_PREFIX.proposal);
    const payload = { memoryId: mintedMemoryId, header, body, tags, kind: 'fact' as const };

    await this.db.insert(proposals).values({
      id: proposalId,
      type: 'create',
      origin: 'agent',
      status: 'pending',
      payload,
      affectedIds: [],
      baseVersions: {},
      contentHash,
      scope,
      projectId: ctx.projectId,
    });

    await this.audit.log({
      eventType: 'proposal_created',
      actor,
      affectedIds: [mintedMemoryId],
      metadata: { proposalId, kind: 'fact' },
    });

    // Best-effort staged embedding (§7 tech-stack "embedding nigdy nie blokuje proposala"):
    // provider down/timeout -> `embedMemoryBestEffort` zwraca null, proposal już powyżej powstał.
    const staged = await this.embedding.embedMemoryBestEffort('fact', header, body, tags);
    if (staged) {
      await this.db.insert(stagingEmbeddings).values(
        staged.chunks.map((c) => ({
          id: generateId(ID_PREFIX.embedding),
          proposalId,
          chunkIndex: c.index,
          chunkText: c.text,
          embeddingModel: staged.model,
          vector: c.vector,
        })),
      );
    }

    return { id: mintedMemoryId, status: 'pending' };
  }

  /**
   * search_memory (FR-M1, FR-R1-R5): dwa ramiona fuzjowane RRF. FTS na całym dokumencie
   * (`memories.fts`, konfiguracja `simple`) — bez chunkingu, więc bez collapse. Wektor na
   * chunkach (`embeddings`, HNSW) — collapse = MIN dystansu per `memory_id` (FR-R3), zawężony
   * do aktywnego modelu (FR-R5). Query-embed fail-open: provider down/timeout → pomijamy ramię
   * wektorowe, RRF degeneruje się do samej listy FTS (identyczne z zachowaniem sprzed Fazy 3).
   * "Dwufazowo" (§6.7) to istniejący split search(nagłówki)/get(body), NIE osobny re-rank pass.
   */
  async search(input: SearchMemoryInput, ctx: ProjectContext): Promise<SearchResultItem[]> {
    const query = input.query?.trim();
    if (!query) {
      throw new ToolError('validation_error', 'query nie może być puste');
    }
    const kinds = input.kind ? [input.kind] : DEFAULT_SEARCH_KINDS;

    let tags: string[] | undefined;
    if (input.tags && input.tags.length > 0) {
      const normalizedTags = normalizeTags(input.tags, this.config);
      if (normalizedTags.length > 0) {
        tags = normalizedTags; // dowolny wspólny tag (any-of)
      }
    }

    const candidateLimit = this.config.get('SEARCH_VECTOR_CANDIDATES');
    const ftsIds = await this.ftsArm(query, ctx, kinds, tags, candidateLimit);

    const qvec = await this.embedding.embedQuery(query); // null = fail-open, ramię pominięte
    const vectorIds = qvec ? await this.vectorArm(qvec, ctx, kinds, tags, candidateLimit) : [];

    const fused = rrfFuse([ftsIds, vectorIds], this.config.get('RRF_K')).slice(
      0,
      this.config.get('SEARCH_TOP_K'),
    );
    if (fused.length === 0) return [];

    const fusedIds = fused.map((f) => f.id);
    const rows = await this.db
      .select({ id: memories.id, header: memories.header, tags: memories.tags, kind: memories.kind })
      .from(memories)
      .where(inArray(memories.id, fusedIds));
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Excerpt tylko dla document (FR-M1) i tylko gdy mamy query-vector do wyboru najlepszego chunku
    // (bez niego nie ma czym rankować chunków — pole zostaje po prostu nieobecne, additive).
    const documentIds = fusedIds.filter((id) => byId.get(id)?.kind === 'document');
    const excerpts = qvec ? await this.documentExcerpts(documentIds, qvec) : new Map<string, string>();

    return fused
      .filter((f) => byId.has(f.id))
      .map((f) => {
        const row = byId.get(f.id)!;
        const excerpt = excerpts.get(f.id);
        return {
          id: row.id,
          header: row.header,
          tags: row.tags,
          score: f.score,
          ...(excerpt !== undefined ? { excerpt } : {}),
        };
      });
  }

  /** Ramię FTS (FR-R2): `plainto_tsquery('simple', …)` + `ts_rank`, zwraca id-y w kolejności rankingu. */
  private async ftsArm(
    query: string,
    ctx: ProjectContext,
    kinds: MemoryKindFilter[],
    tags: string[] | undefined,
    limit: number,
  ): Promise<string[]> {
    // Kolumna `fts` (tsvector, generated always) nie jest zadeklarowana w schemacie drizzle
    // (celowo — Faza 1, patrz komentarz w db/schema/memories.ts: poza zasięgiem drizzle-kit,
    // dokładana ręcznie w migracji). Referencja przez surowy SQL — nazwa nieniejednoznaczna
    // (jedyna tabela w zapytaniu), więc bez kwalifikacji `memories.`.
    const tsQuery = sql`plainto_tsquery('simple', ${query})`;
    const rank = sql<number>`ts_rank(fts, ${tsQuery})`;

    const scopeCondition = or(
      eq(memories.scope, 'global'),
      and(eq(memories.scope, 'project'), eq(memories.projectId, ctx.projectId)),
    );

    const conditions = [
      eq(memories.status, 'approved'),
      sql`fts @@ ${tsQuery}`,
      scopeCondition,
      inArray(memories.kind, kinds),
    ];
    if (tags && tags.length > 0) {
      conditions.push(arrayOverlaps(memories.tags, tags));
    }

    const rows = await this.db
      .select({ id: memories.id })
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(rank))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  /**
   * Ramię wektorowe (FR-R2, FR-R3, FR-R5): cosine ANN (`<=>`, HNSW) na `embeddings`, collapse
   * MIN(dystans) per `memory_id`, zawężone do aktywnego `embedding_model`. Ten sam
   * scope/status/kind/tags predicate co ramię FTS. Zapytanie ANN samo w sobie deleguje do
   * współdzielonego `findAnnNeighbors` (`embeddings/ann-search.ts`, code review finding "reuse",
   * commit d057871) — reużywanego też przez `NightlyService.findNeighborPairs` (dedup), tam z
   * `scopeCondition` ŚCISŁYM zamiast permisywnej unii `global OR project` i `groupByMemory: false`.
   */
  private async vectorArm(
    qvec: number[],
    ctx: ProjectContext,
    kinds: MemoryKindFilter[],
    tags: string[] | undefined,
    limit: number,
  ): Promise<string[]> {
    const scopeCondition = or(
      eq(memories.scope, 'global'),
      and(eq(memories.scope, 'project'), eq(memories.projectId, ctx.projectId)),
    );
    const extraConditions: SQL[] = [inArray(memories.kind, kinds)];
    if (tags && tags.length > 0) {
      extraConditions.push(arrayOverlaps(memories.tags, tags));
    }

    const rows = await findAnnNeighbors({
      db: this.db,
      queryVector: qvec,
      embeddingModel: this.embedding.model,
      scopeCondition,
      extraConditions,
      groupByMemory: true, // FR-R3: MIN(dist) per memoryId — dokumenty mają wiele chunków
      limit,
    });
    return rows.map((r) => r.memoryId);
  }

  /** Najlepiej dopasowany chunk (najmniejszy dystans do query-vector) per `memory_id`, do excerptu. */
  private async documentExcerpts(memoryIds: string[], qvec: number[]): Promise<Map<string, string>> {
    if (memoryIds.length === 0) return new Map();
    const qvecLiteral = toPgVectorLiteral(qvec);
    const dist = sql`${embeddings.vector} <=> ${qvecLiteral}::vector`;
    const rows = await this.db
      .selectDistinctOn([embeddings.memoryId], {
        memoryId: embeddings.memoryId,
        chunkText: embeddings.chunkText,
      })
      .from(embeddings)
      .where(
        and(inArray(embeddings.memoryId, memoryIds), eq(embeddings.embeddingModel, this.embedding.model)),
      )
      .orderBy(embeddings.memoryId, asc(dist));

    return new Map(
      rows.map((r) => [
        r.memoryId,
        r.chunkText.length > EXCERPT_MAX_LEN ? `${r.chunkText.slice(0, EXCERPT_MAX_LEN)}…` : r.chunkText,
      ]),
    );
  }

  /**
   * get_memory (FR-M2, NFR-1): egzekwuje scope (projekt tokena LUB global). Poza scope lub
   * nieistniejące → identyczne `not_found` (anty-probing IDOR — bez rozróżnienia przypadków).
   * Bumpuje `access_count`/`last_accessed_at` bezpośrednio, z pominięciem kolejki (FR-Q5).
   */
  async get(id: string, ctx: ProjectContext): Promise<GetMemoryResult> {
    const [row] = await this.db.select().from(memories).where(eq(memories.id, id)).limit(1);
    if (!row || row.status !== 'approved' || !this.inScope(row, ctx)) {
      throw new ToolError('not_found', `Pamięć nie istnieje: ${id}`);
    }

    const now = new Date();
    await this.db
      .update(memories)
      .set({ accessCount: sql`${memories.accessCount} + 1`, lastAccessedAt: now })
      .where(eq(memories.id, id));

    return {
      id: row.id,
      header: row.header,
      body: row.body,
      kind: row.kind,
      tags: row.tags,
      scope: row.scope,
      projectId: row.projectId,
      accessCount: row.accessCount + 1,
      lastAccessedAt: now.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private inScope(row: MemoryRow, ctx: ProjectContext): boolean {
    if (row.scope === 'global') return true;
    return row.scope === 'project' && row.projectId === ctx.projectId;
  }

  /**
   * [DEV-ONLY] Wstawia approved memory BEZPOŚREDNIO do `memories`, z pominięciem kolejki akceptacji
   * i skanera sekretów. Wyłącznie do ręcznej weryfikacji search/get na żywo przez CLI `seed-memory`
   * (human-create pozostaje Fazą 5). Od Fazy 4 kanoniczna ścieżka produkująca dane E2E-wiernie jest
   * `save()` → `ProposalsService.approve()` (ćwiczy też promocję embeddingu) — `devSeedApproved`
   * zostaje jako szybszy skrót do testów samego search/get, bez przechodzenia przez kolejkę.
   * NIE wystawiać przez MCP ani dashboard. Dokłada authoritative `embeddings` (fail-open, jak
   * wszędzie) — żeby seedowane dane były od razu wektorowo wyszukiwalne bez osobnego `reembed`.
   */
  async devSeedApproved(input: SeedApprovedInput): Promise<MemoryRow> {
    const header = normalizeHeader(input.header);
    const body = validateBody(input.body, input.kind, this.config);
    const tags = normalizeTags(input.tags, this.config);
    const [row] = await this.db
      .insert(memories)
      .values({
        id: generateId(ID_PREFIX.memory),
        header,
        body,
        kind: input.kind,
        tags,
        scope: input.scope,
        projectId: input.scope === 'project' ? (input.projectId ?? null) : null,
        status: 'approved',
        source: 'human',
        approvedAt: new Date(),
      })
      .returning();

    const embedded = await this.embedding.embedMemoryBestEffort(input.kind, header, body, tags);
    if (embedded) {
      await this.db.insert(embeddings).values(
        embedded.chunks.map((c) => ({
          id: generateId(ID_PREFIX.embedding),
          memoryId: row.id,
          chunkIndex: c.index,
          chunkText: c.text,
          embeddingModel: embedded.model,
          vector: c.vector,
        })),
      );
    }
    return row;
  }
}
