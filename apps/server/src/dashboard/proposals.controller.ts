import { Body, Controller, Get, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import type {
  ApproveResult,
  BulkDecisionResult,
  EditResult,
  ProposalView,
} from '../proposals/proposals.types';
import { ProposalsService } from '../proposals/proposals.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DASHBOARD_ACTOR } from './dashboard.constants';
import { DashboardErrorFilter } from './dashboard-error.filter';
import {
  approveBody,
  bulkApproveBody,
  bulkRejectBody,
  editProposalBody,
  emptyQuery,
  opaqueId,
  proposalsListQuery,
  rejectBody,
  type ApproveBody,
  type BulkApproveBody,
  type BulkRejectBody,
  type EditProposalBody,
  type ProposalsListQuery,
  type RejectBody,
} from './dashboard.schemas';

/**
 * FR-D1 Kolejka akceptacji. Wprost na `ProposalsService` (rdzeń Fazy 4, CELOWO nietknięty — §Ryzyka
 * planu) — jedyny dodatek to filtr `type`/`scope=global`, zastosowany TUTAJ (na już pobranej liście),
 * nie w `listPending` (który zostaje dokładnie taki, jaki był).
 *
 * Walidacja query/param/body (tech-review #3, roadmap v1.4) — `ZodValidationPipe` per-argument,
 * schematy w `dashboard.schemas.ts`.
 */
@Controller('api/proposals')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(proposalsListQuery)) query: ProposalsListQuery,
  ): Promise<ProposalView[]> {
    const views = await this.proposals.listPending({
      status: query.status,
      origin: query.origin,
      projectId: query.projectId,
    });
    let filtered = views;
    if (query.type) filtered = filtered.filter((v) => v.type === query.type);
    // `scope=global` — druga forma kontekstu przełącznika (§FR-D6), obok `projectId` (już wspierane
    // natywnie przez `listPending`). Bez `projectId` ani `scope` -> "Wszystkie" (brak filtra).
    if (query.scope === 'global') filtered = filtered.filter((v) => v.scope === 'global');
    return filtered;
  }

  // Literalne trasy `bulk-*` PRZED `:id` (konwencja repo, patrz `MemoriesController` — segmentowo
  // różne od `:id` gołego, ale zadeklarowane pierwsze na wszelki wypadek, żeby Express/Nest nigdy
  // nie musiały rozstrzygać kolejności dopasowania).
  @Post('bulk-approve')
  async bulkApprove(
    @Body(new ZodValidationPipe(bulkApproveBody)) body: BulkApproveBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<BulkDecisionResult> {
    return this.proposals.bulkApprove(body.ids, { actor: DASHBOARD_ACTOR });
  }

  @Post('bulk-reject')
  async bulkReject(
    @Body(new ZodValidationPipe(bulkRejectBody)) body: BulkRejectBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<BulkDecisionResult> {
    return this.proposals.bulkReject(body.ids, { actor: DASHBOARD_ACTOR, reason: body.reason });
  }

  @Get(':id')
  async get(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<ProposalView> {
    return this.proposals.getProposal(id);
  }

  @Post(':id/approve')
  async approve(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Body(new ZodValidationPipe(approveBody)) body: ApproveBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<ApproveResult> {
    return this.proposals.approve(id, {
      actor: DASHBOARD_ACTOR,
      supersedes: body.supersedes,
      expectedSupersedeVersion: body.expectedSupersedeVersion,
    });
  }

  @Post(':id/reject')
  async reject(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Body(new ZodValidationPipe(rejectBody)) body: RejectBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<{ ok: true }> {
    await this.proposals.reject(id, { actor: DASHBOARD_ACTOR, reason: body.reason });
    return { ok: true };
  }

  @Patch(':id')
  async edit(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Body(new ZodValidationPipe(editProposalBody)) body: EditProposalBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<EditResult> {
    return this.proposals.edit(id, body, { actor: DASHBOARD_ACTOR });
  }
}
