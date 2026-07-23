import { Body, Controller, Get, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import type { MemoryKind, MemoryScope, MemoryStatus } from '../db/schema/enums';
import type { RevisionRow } from '../db/schema';
import {
  MemoryAdminService,
  type EditMemoryInput,
  type HumanCreateInput,
  type ListMemoriesFilter,
  type MemoryDetail,
  type MemoryListItem,
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

  @Get(':id')
  async get(@Param('id') id: string): Promise<MemoryDetail> {
    return this.memoryAdmin.getMemoryDetail(id);
  }

  @Get(':id/revisions')
  async revisions(@Param('id') id: string): Promise<RevisionRow[]> {
    return this.memoryAdmin.listRevisions(id);
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
    },
  ): Promise<{ id: string } & WithWarnings> {
    const input: HumanCreateInput = {
      kind: body.kind,
      header: body.header,
      body: body.body,
      tags: body.tags,
      scope: body.scope,
      projectId: body.projectId,
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
