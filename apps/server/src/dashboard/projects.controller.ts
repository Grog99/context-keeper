import { Body, Controller, Get, Param, Patch, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ToolError } from '../common/errors';
import type { ProjectRow } from '../db/schema';
import { ProjectsService, type CreatedProject } from '../projects/projects.service';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DASHBOARD_ACTOR } from './dashboard.constants';
import { DashboardErrorFilter } from './dashboard-error.filter';

export interface ProjectListItem extends ProjectRow {
  memoryCount: number;
}

interface CreateProjectBody {
  name?: string;
}

interface UpdateProjectBody {
  includeEventsInDefaultSearch?: boolean;
}

/**
 * FR-D3 Projekty/tokeny, na `ProjectsService` (Faza 1 — nietknięty poza addytywnym
 * `countMemoriesByProject`). Audyt `token_created`/`token_rotated` (serwis sam nie audytuje, §M1
 * planu) dopisany TUTAJ, w kontrolerze, żeby nie ruszać serwisu Fazy 1 poza jednym addytywnym helperem.
 */
@Controller('api/projects')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(): Promise<ProjectListItem[]> {
    const [rows, counts] = await Promise.all([
      this.projects.listProjects(),
      this.projects.countMemoriesByProject(),
    ]);
    return rows.map((row) => ({ ...row, memoryCount: counts.get(row.id) ?? 0 }));
  }

  @Post()
  async create(@Body() body: CreateProjectBody): Promise<CreatedProject> {
    const name = body?.name?.trim();
    if (!name) {
      throw new ToolError('validation_error', 'name jest wymagany');
    }
    const created = await this.projects.createProject(name);
    await this.audit.log({
      eventType: 'token_created',
      actor: DASHBOARD_ACTOR,
      metadata: { projectId: created.project.id, projectName: created.project.name },
    });
    return created;
  }

  @Post(':id/rotate-token')
  async rotateToken(@Param('id') id: string): Promise<CreatedProject> {
    const rotated = await this.projects.rotateToken(id);
    await this.audit.log({
      eventType: 'token_rotated',
      actor: DASHBOARD_ACTOR,
      metadata: { projectId: rotated.project.id },
    });
    return rotated;
  }

  /** Dialog szczegółów projektu (roadmap v1.2, "kind=event episodic") — dziś jedyne pole jest
   * `includeEventsInDefaultSearch`. `ProjectsService.updateProject` sam nie audytuje (§M1 planu Fazy
   * 5, wzorem create/rotate) — audyt `project_settings_changed` dopisany TUTAJ, z `from`/`to` żeby
   * ekran "Audyt" mógł pokazać co się zmieniło bez osobnego zapytania. `NotFoundException` rzucony
   * przez serwis leci dalej nietknięty (Nest mapuje wbudowane HttpException na 404 samodzielnie —
   * poza `DashboardErrorFilter`, który łapie tylko `ProposalError`/`ToolError`/`PurgeError`). */
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateProjectBody): Promise<ProjectRow> {
    const before = await this.projects.findById(id);
    const updated = await this.projects.updateProject(id, {
      includeEventsInDefaultSearch: body?.includeEventsInDefaultSearch,
    });
    if (body?.includeEventsInDefaultSearch !== undefined) {
      await this.audit.log({
        eventType: 'project_settings_changed',
        actor: DASHBOARD_ACTOR,
        metadata: {
          projectId: id,
          field: 'includeEventsInDefaultSearch',
          from: before?.includeEventsInDefaultSearch ?? null,
          to: updated.includeEventsInDefaultSearch,
        },
      });
    }
    return updated;
  }
}
