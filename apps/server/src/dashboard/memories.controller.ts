import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import type { RevisionRow } from '../db/schema';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  MemoryAdminService,
  type EditMemoryInput,
  type HumanCreateInput,
  type MemoryDetail,
  type MemoryListItem,
  type RelationListItem,
  type WithWarnings,
} from '../memory/memory-admin.service';
import {
  AutoModeUndoService,
  type AutoUndoPreview,
  type AutoUndoResult,
} from '../memory/auto-mode-undo.service';
import { PurgeService, type PurgePreview, type PurgeResult } from '../purge/purge.service';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DASHBOARD_ACTOR } from './dashboard.constants';
import { DashboardErrorFilter } from './dashboard-error.filter';
import {
  autoUndoExecuteBody,
  autoUndoPreviewQuery,
  createRelationBody,
  editMemoryBody,
  emptyBody,
  emptyQuery,
  humanCreateBody,
  memoriesListQuery,
  memoryEventsQuery,
  opaqueId,
  purgeBody,
  type AutoUndoExecuteBody,
  type AutoUndoPreviewQuery,
  type CreateRelationBody,
  type EditMemoryBody,
  type HumanCreateBody,
  type MemoriesListQuery,
  type MemoryEventsQuery,
  type PurgeBody,
} from './dashboard.schemas';

/**
 * FR-D2 Przeglądarka pamięci + FR-D5 Human-create, na `MemoryAdminService` (§Ryzyka planu — NIE
 * `MemoryService.get()`, żeby nigdy nie bumpować `access_count`/`last_accessed_at` z przeglądarki).
 * Od roadmap v1.1 dokłada też hard-purge (`:id/purge-preview`/`:id/purge`) — cienki wrapper nad
 * `PurgeService`, ta sama logika co CLI `purge` (§Guiding principle planu dashboard-nightly-purge).
 *
 * Walidacja query/param/body (tech-review #3, roadmap v1.4) — `ZodValidationPipe` per-argument,
 * schematy w `dashboard.schemas.ts`. KAŻDY handler (nawet bez filtrów) ma pipe na query (Q1
 * resolved, "strict everywhere") — nieznany klucz query zawsze 400.
 */
@Controller('api/memories')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class MemoriesController {
  constructor(
    private readonly memoryAdmin: MemoryAdminService,
    private readonly purgeService: PurgeService,
    private readonly autoUndo: AutoModeUndoService,
  ) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(memoriesListQuery)) query: MemoriesListQuery,
  ): Promise<MemoryListItem[]> {
    return this.memoryAdmin.listMemories({ ...query });
  }

  /** Ekran "Oś czasu" (roadmap v1.2, "kind=event episodic") — deklarowane PRZED `:id` (Express
   * matchuje w kolejności rejestracji; literalne `events` musi wygrać przed dynamicznym `:id`, inaczej
   * `GET /api/memories/events` trafiłby w `get(id='events')`). */
  @Get('events')
  async events(
    @Query(new ZodValidationPipe(memoryEventsQuery)) query: MemoryEventsQuery,
  ): Promise<MemoryListItem[]> {
    return this.memoryAdmin.listEvents({ ...query });
  }

  /** Masowe cofanie auto mode (roadmap v1.6, A3) — literalne trasy `auto-undo/*` PRZED `:id` (jak `events`).
   * Podgląd: liczby z serwera + lista id do archiwizacji; wykonanie archiwizuje dokładnie te id. Tylko sesja
   * dashboardu (`SessionGuard`+`CsrfGuard` kontrolera) — żadne narzędzie MCP tego nie wystawia. */
  @Get('auto-undo/preview')
  async previewAutoUndo(
    @Query(new ZodValidationPipe(autoUndoPreviewQuery)) query: AutoUndoPreviewQuery,
  ): Promise<AutoUndoPreview> {
    return this.autoUndo.preview({ ...query });
  }

  @Post('auto-undo/execute')
  async executeAutoUndo(
    @Body(new ZodValidationPipe(autoUndoExecuteBody)) body: AutoUndoExecuteBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<AutoUndoResult> {
    return this.autoUndo.execute({ projectId: body.projectId, ids: body.ids });
  }

  @Get(':id')
  async get(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<MemoryDetail> {
    return this.memoryAdmin.getMemoryDetail(id);
  }

  @Get(':id/revisions')
  async revisions(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<RevisionRow[]> {
    return this.memoryAdmin.listRevisions(id);
  }

  /**
   * Zakładka "Relacje" (roadmap v1.2, "memory-relations + 1-hop graph boost") — trzy cienkie routy
   * nad `MemoryAdminService`, mirror wzorca `:id/revisions`/`:id/purge-preview` powyżej (żadna z
   * tych 2-/3-segmentowych ścieżek nie koliduje z `:id` — Express matchuje po LICZBIE segmentów,
   * ostrzeżenie o kolejności dotyczy tylko literalnych top-level tras typu `events` powyżej `:id`).
   */
  @Get(':id/relations')
  async listRelations(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<RelationListItem[]> {
    return this.memoryAdmin.listRelations(id);
  }

  /** Walidacja `toId`/`type` (§dashboard.schemas.ts `createRelationBody`) PRZED wejściem w serwis —
   * `type` czytany z jednego źródła prawdy (`relationType.enumValues`), bez przepisywania literałów;
   * `ZodValidationPipe` rzuca `ToolError('validation_error', …)`, który `DashboardErrorFilter`
   * mapuje na 400 (§dashboard-error.filter.ts) — bez tego `type: "bogus"` doleciałby aż do enuma
   * Postgresa (500 zamiast 400), a brak `toId` wysypałby `MemoryAdminService.createRelation`. */
  @Post(':id/relations')
  async createRelation(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Body(new ZodValidationPipe(createRelationBody)) body: CreateRelationBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<{ id: string }> {
    return this.memoryAdmin.createRelation({ fromId: id, toId: body.toId, type: body.type });
  }

  /** Q5 (resolved) — waliduje FORMAT obu `:id`/`:relationId` (`opaqueId`), bez ownership check
   * (behaviour change odłożony do backlogu). `:id` bindowany WYŁĄCZNIE do walidacji, nigdy nie
   * przekazywany do serwisu (usunięcie działa po samym `relationId`, jak przed zmianą). */
  @Delete(':id/relations/:relationId')
  async removeRelation(
    @Param('relationId', new ZodValidationPipe(opaqueId)) relationId: string,
    @Param('id', new ZodValidationPipe(opaqueId)) _id: string = '',
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
    @Body(new ZodValidationPipe(emptyBody)) _body: Record<string, never> = {},
  ): Promise<{ ok: true }> {
    await this.memoryAdmin.removeRelation(relationId);
    return { ok: true };
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(humanCreateBody)) body: HumanCreateBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<{ id: string } & WithWarnings> {
    const input: HumanCreateInput = {
      kind: body.kind,
      header: body.header,
      body: body.body,
      tags: body.tags,
      scope: body.scope,
      projectId: body.projectId,
      eventTime: body.eventTime,
    };
    return this.memoryAdmin.humanCreate(input);
  }

  @Patch(':id')
  async edit(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Body(new ZodValidationPipe(editMemoryBody)) body: EditMemoryBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<WithWarnings> {
    const edits: EditMemoryInput = body;
    return this.memoryAdmin.editMemory(id, edits);
  }

  @Post(':id/archive')
  async archive(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
    @Body(new ZodValidationPipe(emptyBody)) _body: Record<string, never> = {},
  ): Promise<{ ok: true }> {
    await this.memoryAdmin.archiveMemory(id);
    return { ok: true };
  }

  @Post(':id/promote')
  async promote(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
    @Body(new ZodValidationPipe(emptyBody)) _body: Record<string, never> = {},
  ): Promise<{ ok: true }> {
    await this.memoryAdmin.promoteToGlobal(id);
    return { ok: true };
  }

  /** Read-only dry-run (roadmap v1.1) — skala hard-purge PRZED potwierdzeniem, jak `purge` CLI bez
   * `--confirm`. `PurgeService.preview()` sam rzuca `PurgeError('not_found')`, gdy id nie istnieje. */
  @Get(':id/purge-preview')
  async purgePreview(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<PurgePreview> {
    return this.purgeService.preview(id);
  }

  /** Wymaga `reason` (§Resolved design decisions planu — CLI parity, bez typed-id confirmation).
   * `reason` jest teraz WYMAGANY na poziomie kształtu (`purgeBody`) — `PurgeService.purge()` dalej
   * waliduje pusty-po-trim string (`validation_error`), nie duplikujemy tej reguły tutaj. */
  @Post(':id/purge')
  async purge(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Body(new ZodValidationPipe(purgeBody)) body: PurgeBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<PurgeResult> {
    return this.purgeService.purge(id, { reason: body.reason, actor: DASHBOARD_ACTOR });
  }
}
