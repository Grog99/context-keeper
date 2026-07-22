import { Inject, Injectable } from '@nestjs/common';
import { and, arrayOverlaps, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { computeContentHash } from '../common/content-hash';
import { ToolError } from '../common/errors';
import { generateId, ID_PREFIX } from '../common/ids';
import { scanForSecrets } from '../common/secret-scanner';
import { AppConfigService } from '../config/config.service';
import { DB, type Database } from '../db/db.tokens';
import { memories, proposals, type MemoryRow } from '../db/schema';
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

// PRD §11 (otwarta kwestia — knob dostrajany na realnych danych); stała w v1, bez env.
const DEFAULT_TOP_K = 10;
const DEFAULT_SEARCH_KINDS: MemoryKindFilter[] = ['fact', 'document'];

/**
 * Warstwa logiki pamięci (§4-6 tech-stack) — reużywalna później przez kolejkę akceptacji (Faza 4)
 * i dashboard (Faza 5). W Fazie 2 pokrywa dokładnie ścieżkę MCP: save → proposal (bez embeddingu),
 * search → FTS-only na `memories.fts`, get → approved w scope + bump technicznego licznika.
 */
@Injectable()
export class MemoryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
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

    // TODO(Faza 3): podobne-ale-nie-exact → hint „similar to [ids]" po dołożeniu ramienia wektorowego
    // (staging_embeddings). W Fazie 2 (bez embeddingów) nie odróżniamy podobieństwa — proposal
    // powstaje zawsze (FR-M3), to jedyna dopuszczalna uproszczona ścieżka na tym etapie.
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

    return { id: mintedMemoryId, status: 'pending' };
  }

  /**
   * search_memory (FR-M1, FR-R1-R5 — tylko ramię FTS w Fazie 2, ramię wektorowe + RRF w Fazie 3).
   * FTS na całym dokumencie (`memories.fts`, konfiguracja `simple`) — bez chunkingu, więc bez collapse
   * (collapse dotyczy trafień na poziomie chunków wektorowych, które dochodzą w Fazie 3).
   */
  async search(input: SearchMemoryInput, ctx: ProjectContext): Promise<SearchResultItem[]> {
    const query = input.query?.trim();
    if (!query) {
      throw new ToolError('validation_error', 'query nie może być puste');
    }
    const kinds = input.kind ? [input.kind] : DEFAULT_SEARCH_KINDS;

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

    if (input.tags && input.tags.length > 0) {
      const normalizedTags = normalizeTags(input.tags, this.config);
      if (normalizedTags.length > 0) {
        conditions.push(arrayOverlaps(memories.tags, normalizedTags)); // dowolny wspólny tag
      }
    }

    const rows = await this.db
      .select({ id: memories.id, header: memories.header, tags: memories.tags, score: rank })
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(rank))
      .limit(DEFAULT_TOP_K);

    return rows.map((r) => ({ id: r.id, header: r.header, tags: r.tags, score: Number(r.score) }));
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
   * (kolejka akceptacji → Faza 4, human-create → Faza 5). NIE wystawiać przez MCP ani dashboard.
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
    return row;
  }
}
