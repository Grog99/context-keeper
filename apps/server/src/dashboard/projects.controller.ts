import { Body, Controller, Get, NotFoundException, Param, Patch, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ToolError } from '../common/errors';
import type { ProjectRow } from '../db/schema';
import {
  ProjectsService,
  type CreatedProject,
  type CreatedToken,
  type PublicTokenRow,
  type RotatedToken,
  type TokenCounts,
} from '../projects/projects.service';
import { effectiveTokenStatus, type EffectiveTokenStatus } from '../projects/token-status';
import { UsageService } from '../usage/usage.service';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DASHBOARD_ACTOR } from './dashboard.constants';
import { DashboardErrorFilter } from './dashboard-error.filter';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface ProjectListItem extends ProjectRow {
  memoryCount: number;
  /** Badge liczników na `ProjectsScreen` (roadmap v1.3, "Wiele tokenów per projekt + graceful
   * rotation") — zastępuje dawne `tokenStatus` (1 token = 1 status). `grace` liczony LIVE (patrz
   * `ProjectsService.countTokensByProject`). */
  tokenCounts: TokenCounts;
}

/** Dialog "Tokeny" (`ProjectTokensDialog.tsx`) — publiczny wiersz `project_tokens` (NIGDY
 * `token_hash`, patrz `PublicTokenRow`) + `effectiveStatus` liczony server-side (jedna reguła,
 * `token-status.ts`, dzielona z SQL-owym `usableTokenCondition()`) + `searches30d` (atrybucja
 * wyszukań — per-token breakdown na ekranie "Pomiary" jest odłożone, §0 pkt 7 planu). */
export interface ProjectTokenDto extends PublicTokenRow {
  effectiveStatus: EffectiveTokenStatus;
  searches30d: number;
}

interface CreateProjectBody {
  name?: string;
  /** Etykieta pierwszego tokena (roadmap v1.3) — opcjonalna, serwis spada na `DEFAULT_TOKEN_LABEL`. */
  tokenLabel?: string;
}

interface UpdateProjectBody {
  includeEventsInDefaultSearch?: boolean;
}

interface CreateTokenBody {
  label?: string;
}

interface UpdateTokenLabelBody {
  label?: string;
}

/**
 * FR-D3 Projekty/tokeny, na `ProjectsService`. Roadmap v1.3 ("Wiele tokenów per projekt + graceful
 * rotation") rozszerza to o pełne CRUD tokenów per projekt — audyt (`token_created`/`rotated`/
 * `revoked`/`relabeled`) dopisany TUTAJ w kontrolerze (serwis sam nie audytuje, §M1 planu Fazy 5,
 * kontynuacja tej samej konwencji co `createProject`/dawny `rotateToken`).
 *
 * Ownership check (`assertTokenBelongsToProject`) — `:tokenId` w URL nie implikuje `:id`; bez tej
 * kontroli operator mógłby rotować/unieważnić/przemianować token INNEGO projektu podając dowolne
 * `:id` w ścieżce (parametr URL nigdy nie jest zaufany bez weryfikacji, §Risks planu).
 */
@Controller('api/projects')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(): Promise<ProjectListItem[]> {
    const [rows, memoryCounts, tokenCounts] = await Promise.all([
      this.projects.listProjects(),
      this.projects.countMemoriesByProject(),
      this.projects.countTokensByProject(),
    ]);
    return rows.map((row) => ({
      ...row,
      memoryCount: memoryCounts.get(row.id) ?? 0,
      tokenCounts: tokenCounts.get(row.id) ?? { active: 0, grace: 0, revoked: 0 },
    }));
  }

  @Post()
  async create(@Body() body: CreateProjectBody): Promise<CreatedProject> {
    const name = body?.name?.trim();
    if (!name) {
      throw new ToolError('validation_error', 'name jest wymagany');
    }
    const created = await this.projects.createProject(name, body?.tokenLabel);
    await this.audit.log({
      eventType: 'token_created',
      actor: DASHBOARD_ACTOR,
      metadata: {
        projectId: created.project.id,
        projectName: created.project.name,
        tokenId: created.tokenRow.id,
        label: created.tokenRow.label,
      },
    });
    return created;
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

  /** Dialog "Tokeny" — lista + `effectiveStatus`/`searches30d` liczone server-side. */
  @Get(':id/tokens')
  async listTokens(@Param('id') id: string): Promise<ProjectTokenDto[]> {
    const project = await this.projects.findById(id);
    if (!project) {
      throw new NotFoundException(`Projekt nie istnieje: ${id}`);
    }
    const now = new Date();
    const since = new Date(now.getTime() - THIRTY_DAYS_MS);
    const [tokens, searches30d] = await Promise.all([
      this.projects.listTokens(id),
      this.usage.countSearchesByToken(id, since),
    ]);
    return tokens.map((token) => ({
      ...token,
      effectiveStatus: effectiveTokenStatus(token, now),
      searches30d: searches30d.get(token.id) ?? 0,
    }));
  }

  /** Nowy token obok istniejących (§0 pkt 3 planu — etykieta WYMAGANA, walidowana w serwisie). */
  @Post(':id/tokens')
  async createToken(@Param('id') id: string, @Body() body: CreateTokenBody): Promise<CreatedToken> {
    const created = await this.projects.createToken(id, body?.label ?? '');
    await this.audit.log({
      eventType: 'token_created',
      actor: DASHBOARD_ACTOR,
      metadata: { projectId: id, tokenId: created.tokenRow.id, label: created.tokenRow.label },
    });
    return created;
  }

  /** Graceful rotation — stary token idzie w `grace` (usable do `TOKEN_GRACE_PERIOD_HOURS`), nowy
   * zastępuje go od razu. Audyt niesie OBA id/etykiety + moment wygaśnięcia karencji, żeby ekran
   * "Audyt" pokazał pełny obraz bez dodatkowego zapytania. */
  @Post(':id/tokens/:tokenId/rotate')
  async rotateToken(@Param('id') id: string, @Param('tokenId') tokenId: string): Promise<RotatedToken> {
    await this.assertTokenBelongsToProject(id, tokenId);
    const rotated = await this.projects.rotateToken(tokenId);
    await this.audit.log({
      eventType: 'token_rotated',
      actor: DASHBOARD_ACTOR,
      metadata: {
        projectId: id,
        oldTokenId: rotated.previousTokenRow.id,
        oldLabel: rotated.previousTokenRow.label,
        newTokenId: rotated.tokenRow.id,
        newLabel: rotated.tokenRow.label,
        graceExpiresAt: rotated.previousTokenRow.expiresAt,
      },
    });
    return rotated;
  }

  /** Unieważnienie natychmiastowe — działa na `active` I `grace`, idempotentne (§ProjectsService.revokeToken). */
  @Post(':id/tokens/:tokenId/revoke')
  async revokeToken(@Param('id') id: string, @Param('tokenId') tokenId: string): Promise<PublicTokenRow> {
    await this.assertTokenBelongsToProject(id, tokenId);
    const revoked = await this.projects.revokeToken(tokenId);
    await this.audit.log({
      eventType: 'token_revoked',
      actor: DASHBOARD_ACTOR,
      metadata: { projectId: id, tokenId: revoked.id, label: revoked.label },
    });
    return revoked;
  }

  /** Rename etykiety (§0 pkt 5 planu — w zakresie), dozwolony niezależnie od statusu tokena. */
  @Patch(':id/tokens/:tokenId')
  async updateTokenLabel(
    @Param('id') id: string,
    @Param('tokenId') tokenId: string,
    @Body() body: UpdateTokenLabelBody,
  ): Promise<PublicTokenRow> {
    const before = await this.assertTokenBelongsToProject(id, tokenId);
    const updated = await this.projects.updateTokenLabel(tokenId, body?.label ?? '');
    await this.audit.log({
      eventType: 'token_relabeled',
      actor: DASHBOARD_ACTOR,
      metadata: { projectId: id, tokenId, oldLabel: before.label, newLabel: updated.label },
    });
    return updated;
  }

  /** `:tokenId` w URL nie implikuje `:id` — bez tej kontroli operator mógłby dotknąć token innego
   * projektu podając dowolne `:id`. Zwraca znaleziony wiersz (wołający oszczędza drugie zapytanie,
   * np. `updateTokenLabel` potrzebuje starej etykiety do audytu). */
  private async assertTokenBelongsToProject(projectId: string, tokenId: string): Promise<PublicTokenRow> {
    const tokens = await this.projects.listTokens(projectId);
    const found = tokens.find((t) => t.id === tokenId);
    if (!found) {
      throw new NotFoundException(`Token nie istnieje w tym projekcie: ${tokenId}`);
    }
    return found;
  }
}
