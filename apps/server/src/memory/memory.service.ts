import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, arrayOverlaps, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { computeContentHash } from '../common/content-hash';
import { ToolError } from '../common/errors';
import { generateId, ID_PREFIX } from '../common/ids';
import { scanForSecrets } from '../common/secret-scanner';
import { AppConfigService } from '../config/config.service';
import { DB, type Database } from '../db/db.tokens';
import {
  AUTO_MODE_DEFAULT_DAILY_LIMIT,
  auditLog,
  embeddings,
  memories,
  memoryRelations,
  projects,
  proposals,
  stagingEmbeddings,
  type AutoHoldReason,
  type MemoryRow,
  type SimilarMemoryHit,
} from '../db/schema';
import { withTimeout } from '../common/with-timeout';
import { findAnnNeighbors } from '../embeddings/ann-search';
import { EmbeddingService, toPgVectorLiteral, type EmbedMemoryResult } from '../embeddings/embedding.service';
import type { ProjectContext } from '../projects/projects.service';
import { AutoApprovalRefusedError, autoModeActor, countAutoApprovalsInWindow } from '../proposals/auto-mode';
import { ProposalsService } from '../proposals/proposals.service';
import type { RelationPayloadEntry, UpdatePayload } from '../proposals/proposals.types';
import { UsageService } from '../usage/usage.service';
import { evaluateAutoModeGuards } from './auto-mode-guards';
import { classifyDedup } from './dedup';
import { eventDecayFactor } from './decay';
import { graphBoostFactor, selectBoostedIds, type RelationEdge } from './graph-boost';
import type {
  GetMemoryResult,
  MemoryKindFilter,
  SaveMemoryInput,
  SaveMemoryKind,
  SaveMemoryResult,
  SaveRelationInput,
  SearchMemoryInput,
  SearchResultItem,
  SeedApprovedInput,
} from './memory.types';
import { normalizeHeader, normalizeTags, validateBody, validateEventTime } from './validation';
import { isReadable, readScopeCondition, type ReadScope } from './read-scope';
import { findNearDuplicates } from './near-duplicates';
import { rrfFuse } from './rrf';

const DEFAULT_SEARCH_KINDS: MemoryKindFilter[] = ['fact', 'document'];
// Fragment chunku dopasowanego wektorowo, dołączany do wyniku search dla kind=document (FR-M1).
const EXCERPT_MAX_LEN = 280;
// Attach-on-save (roadmap v1.2, "memory-relations + 1-hop graph boost") — twardy cap na liczbę
// krawędzi w JEDNYM save_memory (symetryczny z TAGS_MAX-style limitami, ale nie env-configurable:
// to bezpiecznik przeciw nadużyciu proposala jako hurtowego importu grafu, nie knob do dostrajania).
// UWAGA: dla ścieżki MCP (`save_memory`) to defense-in-depth, NIE pierwsza linia — zod `.max(16)`
// na `relations` w `mcp-server.factory.ts` waliduje wejście PRZED wejściem w handler, więc 17.
// krawędź jest odrzucana tam, generycznym błędem schematu (nie tym czytelnym `validation_error`
// poniżej). Ten komunikat jest osiągalny wyłącznie przy bezpośrednim wywołaniu serwisu (np. testy,
// przyszły caller inny niż MCP) — nie polerować go jako "brakującej" ścieżki dla klienta MCP.
const MAX_RELATIONS_PER_SAVE = 16;

/**
 * Warstwa logiki pamięci (§4-6 tech-stack) — reużywalna później przez kolejkę akceptacji (Faza 4)
 * i dashboard (Faza 5). Save → proposal (+ best-effort staged embedding, Faza 3), search → hybryda
 * FTS+wektor fuzjowana RRF (fail-open do FTS-only przy embedding-down), get → approved w scope
 * + bump technicznego licznika. Od roadmap v1.6 (A2) projekt z auto mode może zatwierdzić zapis od razu
 * (`decideAutoMode` → `ProposalsService.approve({auto:true})`); domyślnie zapis czeka w kolejce.
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly embedding: EmbeddingService,
    private readonly usage: UsageService,
    private readonly proposalsService: ProposalsService,
  ) {}

  /**
   * save_memory (FR-M3-M5, FR-S1, FR-V1). Agent może zaproponować `kind='fact'` (default, gdy
   * `input.kind` pominięty), `kind='document'`, albo — od roadmap v1.3 "kind=event przez agenta" —
   * `kind='event'` z wymaganym `event_time`; `scope` zawsze `project` (`global` to human-only).
   *
   * Gdy `input.supersedes` jest ustawione (roadmap v1.2 "Edycja pamięci przez agenta"), zapis nie
   * mintuje nowej pamięci — deleguje do `saveAsSupersede()`, która produkuje proposal
   * `type='update'` na ISTNIEJĄCYM id (korekta in-place) zamiast `type='create'`.
   *
   * Wynik: `pending`/`duplicate_pending`/`already_exists` jak dotąd; w projekcie z auto mode dodatkowo
   * `approved` (A2) — `id` jest wtedy id PAMIĘCI (korygowanego celu), nie propozycji.
   */
  async save(input: SaveMemoryInput, ctx: ProjectContext): Promise<SaveMemoryResult> {
    const kind = input.kind ?? 'fact';
    const header = normalizeHeader(input.header);
    const body = validateBody(input.body, kind, this.config);
    const tags = normalizeTags(input.tags, this.config);
    const actor = `agent:${ctx.projectId}`;

    // Decyzja #6 (roadmap v1.3): event_time ma sens wyłącznie dla kind=event — cicha utrata daty
    // podanej pod złym kind byłaby footgunem. Mirror precedensu `MemoryAdminService.editMemory:487`.
    if (input.eventTime !== undefined && kind !== 'event') {
      throw new ToolError(
        'validation_error',
        `event_time ma sens wyłącznie dla kind=event (jest: ${kind})`,
      );
    }
    // Korekta eventu (w tym event_time) pozostaje human-only (dashboard) — guard PRZED
    // validateEventTime, żeby komunikat nazywał prawdziwy problem (supersedes na event), a nie
    // brakujący event_time.
    if (kind === 'event' && input.supersedes) {
      throw new ToolError(
        'validation_error',
        'Nie można poprawić pamięci kind=event przez narzędzie — korekta zdarzenia (w tym ' +
          'event_time) jest human-only, w dashboardzie.',
      );
    }
    const eventTime = validateEventTime(input.eventTime, kind); // null dla fact/document

    // Skaner sekretów (§10, FR-S1): agent-save → blokada, materiał nigdy nie dotyka bazy.
    const hit = scanForSecrets(`${header}\n${body}`);
    if (hit) {
      await this.audit.log({
        eventType: 'secret_blocked',
        actor,
        metadata: { secretType: hit.kind, ...this.attribution(ctx) }, // BEZ materiału sekretu (§10)
      });
      throw new ToolError(
        'secret_blocked',
        'Wykryto potencjalny sekret w treści — zapis zablokowany. Usuń materiał sekretu ' +
          '(referuj po nazwie/przeznaczeniu, nigdy po wartości) i spróbuj ponownie.',
      );
    }

    // Korekta istniejącej pamięci (roadmap v1.2 "Edycja pamięci przez agenta"): `supersedes` mapuje
    // się na proposal `type='update'` (reużywa istniejący, dotąd producent-less approve-branch —
    // `ProposalsService.approve` :278-305), NIE na `type='create'`. `return` TUTAJ, PRZED
    // create-path advisory-dedup blokiem niżej — dedup nigdy nie może suppresować korekty (korekta
    // z zamierzenia może być bliźniaczo podobna do treści, którą zastępuje).
    if (input.supersedes) {
      return this.saveAsSupersede(
        { header, body, tags, kind, relations: input.relations },
        input.supersedes,
        ctx,
        actor,
      );
    }

    const scope = 'project' as const; // FR-M4: zapisy agenta tylko project-scoped
    const contentHash = computeContentHash({ header, body, scope, projectId: ctx.projectId, kind, eventTime });

    // Idempotencja (FR-M8): exact match do pending proposala w tym samym projekcie → duplicate_pending.
    // Hash niesie też `kind` (roadmap v1.3 "Dedup kind-aware") — identyczny header+body zapisany pod
    // innym `kind` niż istniejąca pamięć/proposal to ODRĘBNA pamięć, nie duplikat. Dla `kind='event'`
    // niesie też `event_time` (roadmap v1.3 "kind=event przez agenta") — to samo zdarzenie odnotowane
    // dla dwóch różnych czasów to dwie ODRĘBNE pamięci, nie duplikat.
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
    // hash(header+body+scope+project+kind[+event_time]), więc nie modyfikujemy schematu Fazy 1 dla tego.
    // Pomijamy to zapytanie, jeśli pending już wygrał (klasyfikacja i tak go zignoruje).
    let existingMemory: { id: string } | undefined;
    if (!pendingDup) {
      const matchConditions = [
        eq(memories.status, 'approved'),
        eq(memories.scope, scope),
        eq(memories.projectId, ctx.projectId),
        eq(memories.header, header),
        eq(memories.body, body),
        eq(memories.kind, kind),
      ];
      // Field-compare musi zostać semantycznie równoważny hashowi (inwariant §parytet SQL<->TS
      // niżej w testach) — `event_time` dołączony do porównania TYLKO dla `kind='event'`, mirror
      // warunkowości szóstego pola hasha w `computeContentHash`.
      if (kind === 'event' && eventTime) matchConditions.push(eq(memories.eventTime, eventTime));
      [existingMemory] = await this.db
        .select({ id: memories.id })
        .from(memories)
        .where(and(...matchConditions))
        .limit(1);
    }

    const outcome = classifyDedup(pendingDup ?? null, existingMemory ?? null);
    if (outcome.status !== 'pending') {
      // duplicate_pending → id proposala; already_exists → id pamięci (§5 tech-stack, dosłownie).
      return { id: outcome.existingId!, status: outcome.status };
    }

    // Faza 4 seam: staged wektor (zapisywany niżej, best-effort) czeka na PROMOCJĘ do `embeddings`
    // przy akceptacji proposala — promocja żyje w `ProposalsService.approve` (Faza 4), NIE tutaj.
    // Hint FR-M3 "podobne do" (roadmap v1.6, A1) liczymy TUTAJ, na tym samym wektorze, zaraz po
    // embeddingu (niżej) — wynik trafia do `proposals.similar_memories`. Sam hint jest advisory: nic nie
    // jest suppresowane ani odrzucane po podobieństwie; dopiero auto mode (A2, `decideAutoMode` na końcu)
    // używa go jako bezpiecznika (a) i może zwrócić `approved`.
    const mintedMemoryId = generateId(ID_PREFIX.memory);
    const proposalId = generateId(ID_PREFIX.proposal);
    // Attach-on-save (roadmap v1.2): walidowane TERAZ (zanim proposal w ogóle powstanie — spójnie
    // z resztą walidacji save()), materializowane DOPIERO w `ProposalsService.approve()`.
    const relations = await this.resolveRelations(input.relations, ctx, mintedMemoryId);
    const payload = {
      memoryId: mintedMemoryId,
      header,
      body,
      tags,
      kind,
      // Tylko `kind='event'` (roadmap v1.3, "kind=event przez agenta") — ISO string, `payload` jest
      // `jsonb`, więc typ musi mówić prawdę o tym, co siedzi w bazie (nigdy `Date`).
      ...(eventTime ? { eventTime: eventTime.toISOString() } : {}),
      ...(relations.length > 0 ? { relations } : {}),
    };

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
      metadata: { proposalId, kind, ...this.attribution(ctx) },
    });

    // Best-effort staged embedding (§7 tech-stack "embedding nigdy nie blokuje proposala"):
    // provider down/timeout -> `embedMemoryBestEffort` zwraca null, proposal już powyżej powstał.
    // Embedding I wyszukanie podobnych dzielą JEDEN twardy budżet `EMBEDDING_SAVE_TIMEOUT_MS` (deadline
    // liczony od teraz) — przekroczenie = stan "nie policzono" (NULL), nigdy wolniejszy zapis.
    const budgetMs = this.config.get('EMBEDDING_SAVE_TIMEOUT_MS');
    const deadline = Date.now() + budgetMs;
    const staged = await this.embedding.embedMemoryBestEffort(kind, header, body, tags, budgetMs);
    // Detekcja prawie-duplikatów (A1): tylko fact/document (event = zawsze NULL, G4); `null` = nie
    // policzono (brak wektora / deadline / błąd bazy), `[]` = policzono, brak podobnych.
    const similar =
      staged && kind !== 'event' ? await this.detectNearDuplicates(staged, kind, ctx.projectId, deadline) : null;
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

    // Kolejność insert → compute → UPDATE: proposal był już wstawiony do bazy przed jakimkolwiek
    // wywołaniem providera/ANN (inwariant "proposal powstaje zawsze"), a NULL zostaje prawdziwy przy
    // każdej awarii. `updatedAt` celowo NIE ruszamy — to nie jest edycja treści.
    if (similar !== null) {
      try {
        await this.db.update(proposals).set({ similarMemories: similar }).where(eq(proposals.id, proposalId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`near-duplicate: zapis wyniku nie powiódł się (NULL zostaje): ${message}`);
      }
    }

    // Auto mode (roadmap v1.6, A2): proposal i staging już istnieją, `similar` jest znane — decyzja
    // auto/kolejka. Zwracamy id PAMIĘCI w obu przypadkach (G1): przy `approved` pamięć już istnieje, przy
    // `pending` to id, które dostanie po zatwierdzeniu (jak dotąd).
    const status = await this.decideAutoMode({
      ctx,
      proposalId,
      type: 'create',
      kind,
      similar,
      vectorStaged: staged !== null,
    });
    return { id: mintedMemoryId, status };
  }

  /**
   * Podpowiedź „podobne do istniejących" (A1) w ramach POZOSTAŁEGO budżetu zapisu. Fail-open: brak
   * budżetu, timeout albo błąd bazy → `null` ("nie policzono"), nigdy wyjątek — zapis nie może przez
   * to paść. `withTimeout` nie przerywa zapytania w locie, ale `findNearDuplicates` sprawdza deadline
   * między zapytaniami, więc po przekroczeniu budżetu w locie jest co najwyżej jedno.
   */
  private async detectNearDuplicates(
    staged: EmbedMemoryResult,
    kind: 'fact' | 'document',
    projectId: string,
    deadline: number,
  ): Promise<SimilarMemoryHit[] | null> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.logger.warn('near-duplicate fail-open (NULL): budżet zapisu wyczerpany przez embedding');
      return null;
    }
    try {
      return await withTimeout(
        findNearDuplicates({
          db: this.db,
          queryVectors: staged.chunks.map((c) => c.vector),
          embeddingModel: staged.model,
          kind,
          projectId,
          maxDistance: this.config.get('NEAR_DUPLICATE_DISTANCE'),
          deadline,
        }),
        remaining,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`near-duplicate fail-open (NULL): ${message}`);
      return null;
    }
  }

  /**
   * Branch `save()` dla `input.supersedes` (roadmap v1.2 "Edycja pamięci przez agenta"). Produkuje
   * proposal `type='update'`, `origin='agent'` na ISTNIEJĄCYM `targetId` (version+1 in-place),
   * zamiast mintować nową pamięć — `ProposalsService.approve` już umie zaaplikować `type='update'`
   * (merge payload, bump version, revision `edited` z prior snapshotem, delete-then-insert
   * embeddingów, `assertNotStale` po `affectedIds`/`baseVersions`), więc tu tylko WALIDUJEMY target
   * i budujemy proposal. Od A2 (auto mode) na końcu może też od razu zatwierdzić korektę
   * (`decideAutoMode`) — wtedy zwraca `approved` z id CELU zamiast id propozycji.
   *
   * Semantyka = wyłącznie zamiana treści (decyzja produktowa #2 z planu): `header`+`body` ZAWSZE
   * niosą pełną poprawioną treść (wymagane jak przy zwykłym save, walidowane przez `save()` PRZED
   * wywołaniem tej metody) — brak ścieżki "wycofaj bez zamiennika".
   */
  private async saveAsSupersede(
    resolved: {
      header: string;
      body: string;
      tags: string[];
      kind: SaveMemoryKind;
      relations?: SaveRelationInput[];
    },
    targetId: string,
    ctx: ProjectContext,
    actor: string,
  ): Promise<SaveMemoryResult> {
    const { header, body, tags, kind } = resolved;

    // Scope/IDOR gate FIRST (mirror `get()` :394-397, anty-probing): brak wiersza, nie-approved,
    // albo poza scope tokena (inny projekt) -> IDENTYCZNY not_found jak get_memory. Musi poprzedzać
    // KAŻDĄ inną walidację poniżej — nic o kind/version celu nie może wyciec przed tym gate'em.
    const [row] = await this.db.select().from(memories).where(eq(memories.id, targetId)).limit(1);
    if (!row || row.status !== 'approved' || !this.inScope(row, ctx)) {
      throw new ToolError('not_found', `Pamięć do poprawienia nie istnieje: ${targetId}`);
    }

    // Global gate: `inScope` wpuszcza global z KAŻDEGO projektu (agent go widzi przez
    // search/get_memory), więc `not_found` byłby mylący — jawny validation_error zamiast tego.
    // Poprawka globalnej pamięci zostaje wyłącznie human action (dashboard).
    if (row.scope === 'global') {
      throw new ToolError(
        'validation_error',
        'Nie można poprawić pamięci global przez narzędzie — zapisy agenta są project-scoped. ' +
          'Korektę pamięci global wykonuje człowiek w dashboardzie.',
      );
    }

    // Kind gates: `event` jest human-only. Od roadmap v1.3 ("kind=event przez agenta") zod enum w
    // `mcp-server.factory.ts` JUŻ NIE wyklucza `kind='event'` na wejściu, a `save()` ma jawny wczesny
    // guard dla `kind==='event' && input.supersedes` (wyżej) — więc ten wiersz jest teraz PIERWSZĄ
    // linią obrony dla przypadku "target jest eventem, ale żądanie ma inny kind" (np. `kind:'fact'`),
    // nie tylko defense-in-depth. Kind korekty musi zgadzać się z kind celu — bez cichej zmiany
    // fact<->document przy supersede.
    if (row.kind === 'event') {
      throw new ToolError(
        'validation_error',
        'Nie można poprawić pamięci kind=event przez narzędzie — event jest human-only.',
      );
    }
    if (row.kind !== kind) {
      throw new ToolError(
        'validation_error',
        `Kind korekty (${kind}) musi zgadzać się z kind pamięci docelowej (${row.kind}).`,
      );
    }

    const scope = 'project' as const;
    // `kind` tu zawsze == `row.kind` (gate wyżej), więc dołożenie go do hasha jest mechaniczną
    // propagacją współdzielonej definicji, nie nową zachowaniem — utrzymuje niezmiennik "każdy
    // zapisany content_hash = computeContentHash(payload)" bez wyjątków (na nim opiera się migracja).
    // `eventTime: null` jawnie — `kind` tu nigdy nie jest `'event'` (gate `row.kind==='event'` wyżej
    // odrzuca supersede na event PRZED dotarciem tutaj, roadmap v1.3 guard w `save()`), więc szóste
    // pole hasha i tak by się nie dołożyło (`computeContentHash` warunkuje po `kind==='event'`).
    const contentHash = computeContentHash({
      header,
      body,
      scope,
      projectId: ctx.projectId,
      kind,
      eventTime: null,
    });

    // Target-aware idempotencja (odrębna od create-path dedup wyżej): retry IDENTYCZNEJ korekty
    // (ten sam target + ta sama poprawiona treść) -> duplicate_pending wskazujący na istniejący
    // pending proposal `type='update'` dla TEGO targetu, zamiast tworzyć drugi równoległy.
    // `arrayOverlaps` na jednoelementowej liście == containment (ten sam wzorzec co
    // `purge.service.ts:40`); `affectedIds` proposala update zawsze = [targetId] (krok niżej).
    const [pendingUpdate] = await this.db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.contentHash, contentHash),
          eq(proposals.status, 'pending'),
          eq(proposals.type, 'update'),
          eq(proposals.projectId, ctx.projectId),
          arrayOverlaps(proposals.affectedIds, [targetId]),
        ),
      )
      .limit(1);
    if (pendingUpdate) {
      return { id: pendingUpdate.id, status: 'duplicate_pending' };
    }

    const proposalId = generateId(ID_PREFIX.proposal);
    // Attach-on-save (roadmap v1.2): self = targetId (korekta niesie krawędzie OD samej siebie, czyli
    // OD targetu, który jest zapisywany w miejscu) — patrz `resolveRelations` self-loop check.
    const relations = await this.resolveRelations(resolved.relations, ctx, targetId);
    const payload: UpdatePayload = {
      memoryId: targetId,
      header,
      body,
      tags,
      kind,
      ...(relations.length > 0 ? { relations } : {}),
    };

    await this.db.insert(proposals).values({
      id: proposalId,
      type: 'update',
      origin: 'agent',
      status: 'pending',
      payload,
      affectedIds: [targetId],
      // Optimistic concurrency za darmo (§8bis): `assertNotStale` w `ProposalsService.approve` łapie
      // "target zmieniony/zarchiwizowany między search agenta a approve człowieka" bez nowego kodu.
      baseVersions: { [targetId]: row.version },
      contentHash,
      scope,
      projectId: ctx.projectId,
    });

    await this.audit.log({
      eventType: 'proposal_created',
      actor,
      affectedIds: [targetId],
      metadata: { proposalId, kind, type: 'update', supersedes: targetId, ...this.attribution(ctx) },
    });

    // Best-effort staged embedding na POPRAWIONEJ treści — sam wzorzec co create-path wyżej. BEZ
    // detekcji prawie-duplikatów: korekta z definicji przypomina swój cel, więc `similar_memories`
    // zostaje NULL (ticket near-duplicate-detection, G3).
    const staged = await this.embedding.embedMemoryBestEffort(kind, header, body, tags);
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

    // Auto mode (A2): korekta agenta — przy `approved` zwracamy id CELU (pamięć, G1), przy `pending` id
    // propozycji (jak dotąd).
    const status = await this.decideAutoMode({
      ctx,
      proposalId,
      type: 'update',
      kind,
      similar: null,
      vectorStaged: staged !== null,
      target: row,
    });
    return status === 'approved' ? { id: targetId, status } : { id: proposalId, status };
  }

  /**
   * Decyzja auto mode (roadmap v1.6, A2) — wołana PO utworzeniu propozycji (i stagingu embeddingu), więc
   * zapis jest już bezpiecznie utrwalony (inwariant „proposal powstaje zawsze"). Projekt bez auto mode →
   * `pending` bez żadnej pracy ekstra (zachowanie bit-w-bit jak przed A2). Z auto mode: bezpieczniki
   * (`evaluateAutoModeGuards`) → przy jakimkolwiek powodzie powody trafiają na propozycję (G5) i zapis
   * zostaje `pending`; bez powodów `ProposalsService.approve({auto:true})` — ta sama ścieżka co akceptacja
   * człowieka (promocja stagingu, rewizja, relacje, audyt `proposal_approved`), z aktorem maszynowym.
   *
   * Fail-safe (ticket #6): NIGDY nie rzuca. Wyjątek z `approve` → `pending`; `daily_limit` (wyścig na limicie
   * rozstrzygnięty w transakcji) → powód `daily_limit`; `no_vector` → `not_computed`; `disabled` (auto mode
   * wyłączony w międzyczasie) → bez powodu; każdy inny błąd → powód `auto_failed` (D2) + ostrzeżenie w logu.
   * Agent w żadnym z tych przypadków nie dostaje powodu — wyłącznie `pending` (G1).
   */
  private async decideAutoMode(p: {
    ctx: ProjectContext;
    proposalId: string;
    type: 'create' | 'update';
    kind: SaveMemoryKind;
    similar: SimilarMemoryHit[] | null;
    vectorStaged: boolean;
    target?: MemoryRow;
  }): Promise<'approved' | 'pending'> {
    if (p.ctx.autoMode !== true) return 'pending';
    const { ctx, proposalId } = p;
    try {
      const humanTarget =
        p.type === 'update' && p.target !== undefined
          ? p.target.source === 'human' || (await this.hasHumanEdit(p.target.id))
          : false;
      const approvalsInWindow = await countAutoApprovalsInWindow(this.db, ctx.projectId);
      const reasons = evaluateAutoModeGuards({
        type: p.type,
        kind: p.kind,
        similar: p.similar,
        vectorStaged: p.vectorStaged,
        humanTarget,
        approvalsInWindow,
        dailyLimit: ctx.autoModeDailyLimit ?? AUTO_MODE_DEFAULT_DAILY_LIMIT,
      });
      if (reasons.length > 0) {
        await this.persistHoldReasons(proposalId, reasons);
        return 'pending';
      }

      await this.proposalsService.approve(proposalId, {
        actor: autoModeActor(ctx.projectId),
        auto: true,
        recomputeEmbedding: false,
      });
      return 'approved';
    } catch (err) {
      if (err instanceof AutoApprovalRefusedError) {
        if (err.reason === 'daily_limit') await this.persistHoldReasons(proposalId, ['daily_limit']);
        else if (err.reason === 'no_vector') await this.persistHoldReasons(proposalId, ['not_computed']);
        return 'pending'; // 'disabled' — auto mode wyłączony w międzyczasie, nic nie zawrócono
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`auto mode: auto-akceptacja ${proposalId} nie powiodła się (zostaje pending): ${message}`);
      await this.persistHoldReasons(proposalId, ['auto_failed']);
      return 'pending';
    }
  }

  /** Cel korekty miał kiedykolwiek ręczną edycję człowieka (audyt `human_edit` z jego id w `affected_ids`, G3). */
  private async hasHumanEdit(memoryId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.eventType, 'human_edit'), arrayOverlaps(auditLog.affectedIds, [memoryId])))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Utrwala powody zawrócenia na propozycji (G5) — best-effort: błąd bazy nie może zmienić wyniku zapisu
   * (propozycja i tak zostaje `pending`). Warunek `status='pending'` chroni przed nadpisaniem propozycji,
   * którą w międzyczasie zatwierdził człowiek. `updatedAt` celowo nie ruszamy (to nie edycja treści).
   */
  private async persistHoldReasons(proposalId: string, reasons: AutoHoldReason[]): Promise<void> {
    try {
      await this.db
        .update(proposals)
        .set({ autoHoldReasons: reasons })
        .where(and(eq(proposals.id, proposalId), eq(proposals.status, 'pending')));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`auto mode: zapis powodów zawrócenia (${proposalId}) nie powiódł się: ${message}`);
    }
  }

  /**
   * Walidacja `input.relations` (roadmap v1.2, "memory-relations + 1-hop graph boost", ATTACH-ON-SAVE
   * — locked decision planu). Woła się z OBU ścieżek `save()` (create z `selfId=mintedMemoryId`,
   * `saveAsSupersede` z `selfId=targetId`) — walidacja PRZED utworzeniem proposala, materializacja
   * (insert do `memory_relations`) dopiero w `ProposalsService.approve()` (§ProposalsService
   * "materializeRelations"). Zwraca `[]` gdy `relations` nie podano — czysto addytywne, nic się nie
   * zmienia dla istniejących wywołujących.
   *
   * Taksonomia MIRRORUJE `saveAsSupersede` (IDOR-safe, identyczna z `get_memory`): cel nieznany, nie
   * approved, albo poza scope tokena → `not_found` (bez rozróżnienia przypadków, anty-probing);
   * `scope=global` → `validation_error` (relacje agenta są project-scoped, jak reszta zapisów).
   * ŚWIADOME odstępstwo od `saveAsSupersede` (Stage-2 answer #1): BRAK kind gate — `kind=event` jako
   * cel jest DOZWOLONY (relacje są ortogonalne do `event_time`, np. "ten fakt jest kontekstem dla
   * tego zdarzenia" to właśnie `context_for` wskazujący na event).
   */
  private async resolveRelations(
    relations: SaveRelationInput[] | undefined,
    ctx: ProjectContext,
    selfId: string,
  ): Promise<RelationPayloadEntry[]> {
    if (!relations || relations.length === 0) return [];
    if (relations.length > MAX_RELATIONS_PER_SAVE) {
      throw new ToolError(
        'validation_error',
        `Zbyt wiele relations (max ${MAX_RELATIONS_PER_SAVE}, jest ${relations.length})`,
      );
    }

    // Dedup po (type,targetId) — zachowuje kolejność pierwszego wystąpienia, ciche scalanie
    // (bez błędu — agent mógł powtórzyć się nieumyślnie, to nie jest walidacyjny problem).
    const seen = new Set<string>();
    const deduped: SaveRelationInput[] = [];
    for (const rel of relations) {
      const key = `${rel.type}:${rel.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(rel);
    }

    // Self-loop gate PRZED zapytaniem do DB — deterministyczne z samych id-ów, bez potrzeby lookupu.
    for (const rel of deduped) {
      if (rel.targetId === selfId) {
        throw new ToolError(
          'validation_error',
          `Relacja nie może wskazywać na samą siebie: ${rel.targetId}`,
        );
      }
    }

    // Scope/IDOR gate (mirror `saveAsSupersede`, anty-probing) — jedno zapytanie na wszystkie
    // unikalne cele naraz, zamiast N zapytań w pętli.
    const targetIds = Array.from(new Set(deduped.map((r) => r.targetId)));
    const rows = await this.db.select().from(memories).where(inArray(memories.id, targetIds));
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const targetId of targetIds) {
      const row = byId.get(targetId);
      if (!row || row.status !== 'approved' || !this.inScope(row, ctx)) {
        throw new ToolError('not_found', `Pamięć docelowa relacji nie istnieje: ${targetId}`);
      }
      if (row.scope === 'global') {
        throw new ToolError(
          'validation_error',
          `Relacja nie może wskazywać na pamięć global: ${targetId} — relacje agenta są project-scoped.`,
        );
      }
    }

    return deduped.map((r) => ({ type: r.type, targetId: r.targetId }));
  }

  /**
   * search_memory (FR-M1, FR-R1-R5): dwa ramiona fuzjowane RRF. FTS na całym dokumencie
   * (`memories.fts`, konfiguracja `simple`) — bez chunkingu, więc bez collapse. Wektor na
   * chunkach (`embeddings`, HNSW) — collapse = MIN dystansu per `memory_id` (FR-R3), zawężony
   * do aktywnego modelu (FR-R5). Query-embed fail-open: provider down/timeout → pomijamy ramię
   * wektorowe, RRF degeneruje się do samej listy FTS (identyczne z zachowaniem sprzed Fazy 3).
   * "Dwufazowo" (§6.7) to istniejący split search(nagłówki)/get(body), NIE osobny re-rank pass.
   *
   * Instrumentacja (roadmap v1.1, "Pomiary", plan §5(e)): dokładnie JEDEN zapis `search_events`
   * na wywołanie, przez wspólny tail (jeden punkt `return`, celowo — dawniej dwa return-y). Fail-open
   * (`recordSearchSafe`) — awaria zapisu instrumentacji NIGDY nie zamienia dobrego wyniku w błąd.
   *
   * Default-kind + age-decay (roadmap v1.2, "kind=event episodic"): gdy `input.kind` nie podano,
   * domyślny zestaw to `DEFAULT_SEARCH_KINDS` (fact+document), z `event` dołożonym TYLKO gdy
   * `ctx.includeEventsInDefaultSearch === true` (per-projektowy toggle) — jawny `kind` (włącznie z
   * `'event'`) jest zawsze honorowany bez względu na toggle. Age-decay aplikowany POST-RRF, tylko do
   * `kind=event` (`memory/decay.ts`) — MUSI poprzedzać `slice(0, SEARCH_TOP_K)`, bo decay może
   * wypchnąć event poza widoczne okno i wpuścić fact/document niżej rankowany przez RRF; stąd
   * metadane pobierane dla PEŁNEGO sfuzjowanego zbioru (ograniczonego przez limit kandydatów
   * każdego ramienia, ≤~100), re-sort po `effectiveScore`, dopiero potem slice.
   *
   * 1-hop graph boost (roadmap v1.2, "memory-relations + 1-hop graph boost"): trzeci multiplikatywny
   * faktor obok `decayFactor` (§memory/graph-boost.ts), RE-RANK ONLY — `fetchInSetEdges` zwraca
   * WYŁĄCZNIE krawędzie, których OBA końce są już w `fusedIds` (nigdy nie wstrzykuje pamięci spoza
   * sfuzjowanego zbioru). `GRAPH_BOOST_WEIGHT<=0` pomija dodatkowe zapytanie o krawędzie całkowicie
   * (perf — zero kosztu, gdy funkcja wyłączona knobem).
   *
   * Tryb cross-project (roadmap v1.5, `readScope === 'all_projects'`; zakres rozstrzyga warstwa MCP
   * z typu tokena, serwis nie zna typów tokenów): pamięć global + KAŻDEGO projektu w jednej puli RRF,
   * z tymi samymi limitami kandydatów i `SEARCH_TOP_K`, BEZ boostu bieżącego projektu (G5). Warunek
   * zakresu (`read-scope.ts`) budowany raz i przekazywany obu ramionom. Graph boost bierze krawędzie
   * KAŻDEGO projektu obecnego w zbiorze wyników (G8) — krawędzie są intra-project, więc nie powstaje
   * boost między projektami. Domyślny zestaw `kind` zależy od toggle'a BIEŻĄCEGO projektu (G7, jak
   * dla global). Wyniki niosą `project` (slug lub `null` dla global); w trybie domyślnym pola nie
   * ma. Jeden wiersz `search_events` z `cross_project=true` pod bieżącym projektem (G9), bez wpisu
   * w `audit_log`.
   */
  async search(
    input: SearchMemoryInput,
    ctx: ProjectContext,
    readScope: ReadScope = 'project',
  ): Promise<SearchResultItem[]> {
    const query = input.query?.trim();
    if (!query) {
      throw new ToolError('validation_error', 'query nie może być puste');
    }
    const kinds = input.kind
      ? [input.kind]
      : ctx.includeEventsInDefaultSearch === true
        ? [...DEFAULT_SEARCH_KINDS, 'event' as const]
        : DEFAULT_SEARCH_KINDS;

    let tags: string[] | undefined;
    if (input.tags && input.tags.length > 0) {
      const normalizedTags = normalizeTags(input.tags, this.config);
      if (normalizedTags.length > 0) {
        tags = normalizedTags; // dowolny wspólny tag (any-of)
      }
    }

    const crossProject = readScope === 'all_projects';
    // Jeden warunek zakresu dla OBU ramion — tryb cross nie może zostać przełączony "pół na pół".
    const scopeCondition = readScopeCondition(readScope, ctx.projectId);

    const candidateLimit = this.config.get('SEARCH_VECTOR_CANDIDATES');
    const ftsIds = await this.ftsArm(query, scopeCondition, kinds, tags, candidateLimit);

    const qvec = await this.embedding.embedQuery(query); // null = fail-open, ramię pominięte
    const vectorIds = qvec
      ? await this.vectorArm(qvec, scopeCondition, kinds, tags, candidateLimit)
      : [];

    // Bez wczesnego slice(SEARCH_TOP_K) — pełny sfuzjowany zbiór (naturalnie ograniczony do
    // ~2×candidateLimit unikalnych id) idzie do age-decay + re-sort niżej, top-k dopiero po.
    const fused = rrfFuse([ftsIds, vectorIds], this.config.get('RRF_K'));

    let results: SearchResultItem[] = [];
    if (fused.length > 0) {
      const fusedIds = fused.map((f) => f.id);
      const rows = await this.db
        .select({
          id: memories.id,
          header: memories.header,
          tags: memories.tags,
          kind: memories.kind,
          eventTime: memories.eventTime,
          projectId: memories.projectId,
          projectSlug: projects.slug,
        })
        .from(memories)
        // LEFT: pamięć global ma `project_id IS NULL`. Slug trafia do wyniku tylko w trybie cross.
        .leftJoin(projects, eq(projects.id, memories.projectId))
        .where(inArray(memories.id, fusedIds));
      const byId = new Map(rows.map((r) => [r.id, r]));

      // Graph boost (roadmap v1.2): `weight<=0` -> pomiń zapytanie o krawędzie, `boosted` zostaje
      // pusty (graphBoostFactor(false, …) === 1, no-op identyczny z dzisiejszym zachowaniem).
      const graphBoostWeight = this.config.get('GRAPH_BOOST_WEIGHT');
      // Cross (G8): krawędzie każdego projektu obecnego w zbiorze wyników; domyślnie tylko bieżącego.
      const edgeProjectIds = crossProject
        ? [...new Set(rows.map((r) => r.projectId).filter((p): p is string => p !== null))]
        : [ctx.projectId];
      const boosted =
        graphBoostWeight > 0
          ? selectBoostedIds(fusedIds, await this.fetchInSetEdges(fusedIds, edgeProjectIds))
          : new Set<string>();

      const now = new Date();
      const halflifeDays = this.config.get('EVENT_DECAY_HALFLIFE_DAYS');
      const decayed = fused
        .filter((f) => byId.has(f.id))
        .map((f) => {
          const row = byId.get(f.id)!;
          // decayFactor=1 dla fact/document (zero wpływu na ranking) — tylko event decayuje.
          const decayFactor = row.kind === 'event' ? eventDecayFactor(row.eventTime, now, halflifeDays) : 1;
          const boostFactor = graphBoostFactor(boosted.has(f.id), graphBoostWeight);
          return { row, effectiveScore: f.score * decayFactor * boostFactor };
        })
        .sort((a, b) => b.effectiveScore - a.effectiveScore)
        .slice(0, this.config.get('SEARCH_TOP_K'));

      // Excerpt tylko dla document (FR-M1) i tylko gdy mamy query-vector do wyboru najlepszego chunku
      // (bez niego nie ma czym rankować chunków — pole zostaje po prostu nieobecne, additive).
      // Liczony DOPIERO dla ocalałych po slice (nie dla całego kandydackiego zbioru).
      const documentIds = decayed.filter((d) => d.row.kind === 'document').map((d) => d.row.id);
      const excerpts = qvec ? await this.documentExcerpts(documentIds, qvec) : new Map<string, string>();

      results = decayed.map(({ row, effectiveScore }) => {
        const excerpt = excerpts.get(row.id);
        return {
          id: row.id,
          header: row.header,
          tags: row.tags,
          score: effectiveScore,
          ...(crossProject ? { project: row.projectSlug ?? null } : {}),
          ...(excerpt !== undefined ? { excerpt } : {}),
        };
      });
    }

    await this.recordSearchSafe(ctx.projectId, ctx.tokenId, results.length, qvec === null, crossProject);
    return results;
  }

  /**
   * Fail-open (plan §1b "Hot-path safety", §5(e)): instrumentacja NIGDY nie może zamienić dobrego
   * `search()` w błąd — awaria insertu jest złapana i zalogowana, nie propagowana. `degraded` = brak
   * query-vectora (embedding provider down/timeout) — patrz komentarz przy `search_events` w
   * `db/schema/search-events.ts`. `tokenId` (roadmap v1.3, "Wiele tokenów per projekt + graceful
   * rotation") — atrybucja per-agent na `search_events`, `undefined` gdy `ctx` nie niesie tokena
   * (np. ręcznie budowany kontekst w testach) -> kolumna zostaje `NULL`, symetrycznie z resztą
   * opcjonalnych pól `ProjectContext`. `crossProject` (roadmap v1.5) — wyszukiwanie z `all_projects`,
   * zapisywane pod bieżącym projektem z flagą.
   */
  private async recordSearchSafe(
    projectId: string,
    tokenId: string | undefined,
    resultCount: number,
    degraded: boolean,
    crossProject: boolean,
  ): Promise<void> {
    try {
      await this.usage.recordSearch({
        projectId,
        tokenId: tokenId ?? null,
        resultCount,
        degraded,
        crossProject,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[usage] recordSearch nie powiódł się (fail-open, wynik search() nietknięty): ${message}`);
    }
  }

  /**
   * Atrybucja per-agent (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") — spread do
   * `metadata` na wszystkich agent-path audit calls (`secret_blocked`, `proposal_created` z obu
   * ścieżek `save()`). `ctx.tokenId` opcjonalny (§ProjectContext) -> `{}` gdy nieobecny, żeby stare
   * ręcznie budowane konteksty (testy) dalej dawały metadata bez `tokenId`/`tokenLabel` zamiast
   * `undefined` wartości zaśmiecających JSON. `get()` CELOWO nie woła tego — nie jest w
   * `search_events` z design (ma już `access_count`) i nie audytuje żadnego wpisu, więc nie ma
   * gdzie by ta atrybucja miała trafić.
   */
  private attribution(ctx: ProjectContext): { tokenId?: string; tokenLabel?: string } {
    return ctx.tokenId ? { tokenId: ctx.tokenId, tokenLabel: ctx.tokenLabel } : {};
  }

  /** Ramię FTS (FR-R2): `plainto_tsquery('simple', …)` + `ts_rank`, zwraca id-y w kolejności rankingu. */
  private async ftsArm(
    query: string,
    scopeCondition: SQL,
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
   * scope/status/kind/tags predicate co ramię FTS — `scopeCondition` przychodzi z `read-scope.ts`
   * (budowany raz w `search()`, wspólny dla obu ramion). Zapytanie ANN samo w sobie deleguje do
   * współdzielonego `findAnnNeighbors` (`embeddings/ann-search.ts`, code review finding "reuse",
   * commit d057871) — reużywanego też przez `NightlyService.findNeighborPairs` (dedup), tam z
   * `scopeCondition` ŚCISŁYM zamiast unii z `read-scope.ts` i `groupByMemory: false`.
   */
  private async vectorArm(
    qvec: number[],
    scopeCondition: SQL,
    kinds: MemoryKindFilter[],
    tags: string[] | undefined,
    limit: number,
  ): Promise<string[]> {
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

  /**
   * Krawędzie `memory_relations` dla graph boost (roadmap v1.2), RE-RANK ONLY: `WHERE project_id=…
   * AND from IN(ids) AND to IN(ids)` — filtr obu końców na poziomie SQL, nie tylko w
   * `selectBoostedIds` (§graph-boost.ts), więc zapytanie samo w sobie nigdy nie zwraca krawędzi
   * wychodzącej poza sfuzjowany zbiór. Project-scoped (edges są ściśle intra-project, §db/schema/
   * memory-relations.ts), więc filtr po `projectIds` (domyślnie tylko bieżący projekt, w trybie cross
   * wszystkie projekty obecne w wynikach) nie może stworzyć boostu między projektami.
   */
  private async fetchInSetEdges(ids: string[], projectIds: string[]): Promise<RelationEdge[]> {
    if (ids.length === 0 || projectIds.length === 0) return [];
    const rows = await this.db
      .select({ fromMemoryId: memoryRelations.fromMemoryId, toMemoryId: memoryRelations.toMemoryId })
      .from(memoryRelations)
      .where(
        and(
          inArray(memoryRelations.projectId, projectIds),
          inArray(memoryRelations.fromMemoryId, ids),
          inArray(memoryRelations.toMemoryId, ids),
        ),
      );
    return rows;
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
   * get_memory (FR-M2, NFR-1): egzekwuje zakres odczytu (`readScope`, domyślnie projekt tokena LUB
   * global). Poza zakresem lub nieistniejące → identyczne `not_found` (anty-probing IDOR — bez
   * rozróżnienia przypadków). Dla tokenu konta fabryka MCP przekazuje `'all_projects'` (roadmap v1.5,
   * G6) — pamięć dowolnego projektu. Zakres liczy `isReadable` (`read-scope.ts`), CELOWO nie
   * `inScope` — ten zostaje wyłącznie dla gate'ów zapisu. Bump `access_count`/`last_accessed_at`
   * bezpośrednio, z pominięciem kolejki (FR-Q5), w obu trybach (G6a).
   */
  async get(id: string, ctx: ProjectContext, readScope: ReadScope = 'project'): Promise<GetMemoryResult> {
    const [row] = await this.db.select().from(memories).where(eq(memories.id, id)).limit(1);
    if (!row || row.status !== 'approved' || !isReadable(row, readScope, ctx.projectId)) {
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
      eventTime: row.eventTime ? row.eventTime.toISOString() : null,
    };
  }

  /**
   * Gate ZAPISU (`supersedes`, `relations`): ściśle projekt kontekstu + global. NIE poszerzać pod
   * odczyt cross-project — ten idzie przez `read-scope.ts` (`isReadable`).
   */
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
