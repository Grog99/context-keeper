import { Body, Controller, Get, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import type { ProposalOrigin, ProposalStatus, ProposalType } from '../db/schema/enums';
import type { ApproveResult, EditInput, EditResult, ProposalView } from '../proposals/proposals.types';
import { ProposalsService } from '../proposals/proposals.service';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DASHBOARD_ACTOR } from './dashboard.constants';
import { DashboardErrorFilter } from './dashboard-error.filter';

interface ApproveBody {
  supersedes?: string;
  expectedSupersedeVersion?: number;
}

interface RejectBody {
  reason?: string;
}

/**
 * FR-D1 Kolejka akceptacji. Wprost na `ProposalsService` (rdzeń Fazy 4, CELOWO nietknięty — §Ryzyka
 * planu) — jedyny dodatek to filtr `type`/`scope=global`, zastosowany TUTAJ (na już pobranej liście),
 * nie w `listPending` (który zostaje dokładnie taki, jaki był).
 */
@Controller('api/proposals')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Get()
  async list(
    @Query('status') status?: ProposalStatus,
    @Query('origin') origin?: ProposalOrigin,
    @Query('type') type?: ProposalType,
    @Query('projectId') projectId?: string,
    @Query('scope') scope?: string,
  ): Promise<ProposalView[]> {
    const views = await this.proposals.listPending({ status, origin, projectId });
    let filtered = views;
    if (type) filtered = filtered.filter((v) => v.type === type);
    // `scope=global` — druga forma kontekstu przełącznika (§FR-D6), obok `projectId` (już wspierane
    // natywnie przez `listPending`). Bez `projectId` ani `scope` -> "Wszystkie" (brak filtra).
    if (scope === 'global') filtered = filtered.filter((v) => v.scope === 'global');
    return filtered;
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ProposalView> {
    return this.proposals.getProposal(id);
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @Body() body: ApproveBody): Promise<ApproveResult> {
    return this.proposals.approve(id, {
      actor: DASHBOARD_ACTOR,
      supersedes: body?.supersedes,
      expectedSupersedeVersion: body?.expectedSupersedeVersion,
    });
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @Body() body: RejectBody): Promise<{ ok: true }> {
    await this.proposals.reject(id, { actor: DASHBOARD_ACTOR, reason: body?.reason });
    return { ok: true };
  }

  @Patch(':id')
  async edit(@Param('id') id: string, @Body() body: EditInput): Promise<EditResult> {
    return this.proposals.edit(id, body, { actor: DASHBOARD_ACTOR });
  }
}
