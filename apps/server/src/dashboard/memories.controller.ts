import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { relationType, type MemoryKind, type MemoryScope, type MemoryStatus, type RelationType } from '../db/schema/enums';
import type { RevisionRow } from '../db/schema';
import { ToolError } from '../common/errors';
import {
  MemoryAdminService,
  type EditMemoryInput,
  type HumanCreateInput,
  type ListEventsFilter,
  type ListMemoriesFilter,
  type MemoryDetail,
  type MemoryListItem,
  type RelationListItem,
  type WithWarnings,
} from '../memory/memory-admin.service';
import { PurgeService, type PurgePreview, type PurgeResult } from '../purge/purge.service';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DASHBOARD_ACTOR } from './dashboard.constants';
import { DashboardErrorFilter } from './dashboard-error.filter';

function toStringArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * FR-D2 Przeglądarka pamięci + FR-D5 Human-create, na `MemoryAdminService` (§Ryzyka planu — NIE
 * `MemoryService.get()`, żeby nigdy nie bumpować `access_count`/`last_accessed_at` z przeglądarki).
 * Od roadmap v1.1 dokłada też hard-purge (`:id/purge-preview`/`:id/purge`) — cienki wrapper nad
 * `PurgeService`, ta sama logika co CLI `purge` (§Guiding principle planu dashboard-nightly-purge).
 */
@Controller('api/memories')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class MemoriesController {
  constructor(
    private readonly memoryAdmin: MemoryAdminService,
    private readonly purgeService: PurgeService,
  ) {}

  @Get()
  async list(
    @Query('scope') scope?: ListMemoriesFilter['scope'],
    @Query('projectId') projectId?: string,
    @Query('kind') kind?: MemoryKind,
    @Query('status') status?: MemoryStatus,
    @Query('tags') tags?: string | string[],
    @Query('q') q?: string,
  ): Promise<MemoryListItem[]> {
    return this.memoryAdmin.listMemories({ scope, projectId, kind, status, tags: toStringArray(tags), q });
  }

  /** Ekran "Oś czasu" (roadmap v1.2, "kind=event episodic") — deklarowane PRZED `:id` (Express
   * matchuje w kolejności rejestracji; literalne `events` musi wygrać przed dynamicznym `:id`, inaczej
   * `GET /api/memories/events` trafiłby w `get(id='events')`). */
  @Get('events')
  async events(
    @Query('scope') scope?: ListEventsFilter['scope'],
    @Query('projectId') projectId?: string,
  ): Promise<MemoryListItem[]> {
    return this.memoryAdmin.listEvents({ scope, projectId });
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<MemoryDetail> {
    return this.memoryAdmin.getMemoryDetail(id);
  }

  @Get(':id/revisions')
  async revisions(@Param('id') id: string): Promise<RevisionRow[]> {
    return this.memoryAdmin.listRevisions(id);
  }

  /**
   * Zakładka "Relacje" (roadmap v1.2, "memory-relations + 1-hop graph boost") — trzy cienkie routy
   * nad `MemoryAdminService`, mirror wzorca `:id/revisions`/`:id/purge-preview` powyżej (żadna z
   * tych 2-/3-segmentowych ścieżek nie koliduje z `:id` — Express matchuje po LICZBIE segmentów,
   * ostrzeżenie o kolejności dotyczy tylko literalnych top-level tras typu `events` powyżej `:id`).
   */
  @Get(':id/relations')
  async listRelations(@Param('id') id: string): Promise<RelationListItem[]> {
    return this.memoryAdmin.listRelations(id);
  }

  /** `@Body()` powyżej to czysta asercja typu TS — bez globalnego `ValidationPipe` w `main.ts`
   * (świadome: MCP i tak waliduje zod-em na wejściu narzędzia, `main.ts` go nie potrzebował do
   * teraz) request z `type: "bogus"` doleciałby aż do enuma Postgresa (500 zamiast 400), a brak
   * `toId` wysypałby `MemoryAdminService.createRelation`'s `inArray(memories.id, [fromId, undefined])`.
   * Walidujemy więc explicit, PRZED wejściem w serwis, tym samym `ToolError('validation_error', …)`
   * co reszta ścieżek dashboardu — `DashboardErrorFilter` mapuje go na 400 (§dashboard-error.filter.ts).
   * Wartości `type` czytane z jednego źródła prawdy (`relationType.enumValues`, §db/schema/enums.ts),
   * bez przepisywania literałów. */
  @Post(':id/relations')
  async createRelation(
    @Param('id') id: string,
    @Body() body: { toId: string; type: RelationType },
  ): Promise<{ id: string }> {
    const toId = body?.toId;
    if (typeof toId !== 'string' || toId.length === 0) {
      throw new ToolError('validation_error', 'toId jest wymagany');
    }
    const type = body?.type;
    if (!relationType.enumValues.includes(type)) {
      throw new ToolError(
        'validation_error',
        `type musi być jednym z: ${relationType.enumValues.join(', ')}`,
      );
    }
    return this.memoryAdmin.createRelation({ fromId: id, toId, type });
  }

  @Delete(':id/relations/:relationId')
  async removeRelation(@Param('relationId') relationId: string): Promise<{ ok: true }> {
    await this.memoryAdmin.removeRelation(relationId);
    return { ok: true };
  }

  @Post()
  async create(
    @Body()
    body: {
      kind: MemoryKind;
      header: string;
      body: string;
      tags?: string[];
      scope: MemoryScope;
      projectId?: string | null;
      /** Wymagany gdy `kind='event'` (roadmap v1.2) — ISO timestamp, backdatable. */
      eventTime?: string;
    },
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
  async edit(@Param('id') id: string, @Body() body: EditMemoryInput): Promise<WithWarnings> {
    return this.memoryAdmin.editMemory(id, body);
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string): Promise<{ ok: true }> {
    await this.memoryAdmin.archiveMemory(id);
    return { ok: true };
  }

  @Post(':id/promote')
  async promote(@Param('id') id: string): Promise<{ ok: true }> {
    await this.memoryAdmin.promoteToGlobal(id);
    return { ok: true };
  }

  /** Read-only dry-run (roadmap v1.1) — skala hard-purge PRZED potwierdzeniem, jak `purge` CLI bez
   * `--confirm`. `PurgeService.preview()` sam rzuca `PurgeError('not_found')`, gdy id nie istnieje. */
  @Get(':id/purge-preview')
  async purgePreview(@Param('id') id: string): Promise<PurgePreview> {
    return this.purgeService.preview(id);
  }

  /** Wymaga `reason` (§Resolved design decisions planu — CLI parity, bez typed-id confirmation).
   * `PurgeService.purge()` waliduje pusty `reason` sam (`validation_error`) — nie duplikujemy tu. */
  @Post(':id/purge')
  async purge(@Param('id') id: string, @Body() body: { reason: string }): Promise<PurgeResult> {
    return this.purgeService.purge(id, { reason: body?.reason ?? '', actor: DASHBOARD_ACTOR });
  }
}
