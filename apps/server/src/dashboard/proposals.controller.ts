import { Body, Controller, Get, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import type {
  ApproveResult,
  BulkDecisionResult,
  EditResult,
  ProposalListPage,
  ProposalView,
  SwapDirectionResult,
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
  swapDirectionBody,
  type ApproveBody,
  type BulkApproveBody,
  type BulkRejectBody,
  type EditProposalBody,
  type ProposalsListQuery,
  type RejectBody,
  type SwapDirectionBody,
} from './dashboard.schemas';

/**
 * FR-D1 Kolejka akceptacji. Wprost na `ProposalsService` (rdzeń Fazy 4 — approve/reject/edit
 * nietknięte). Lista (`GET /api/proposals`) to lekka, stronicowana `listPendingPage`: wszystkie
 * filtry (`status`/`origin`/`projectId`/`type`/`scope=global`) schodzą do SQL, odpowiedź to
 * `{ items, nextCursor, total }` bez `payload`; pełny widok propozycji — `GET :id`.
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
  ): Promise<ProposalListPage> {
    return this.proposals.listPendingPage({
      status: query.status,
      origin: query.origin,
      projectId: query.projectId,
      type: query.type,
      // `scope=global` — druga forma kontekstu przełącznika (§FR-D6), obok `projectId`. Bez
      // `projectId` ani `scope` -> "Wszystkie" (brak filtra); inna wartość `LIST_SCOPES` nie filtruje.
      scope: query.scope === 'global' ? 'global' : undefined,
      limit: query.limit,
      cursor: query.cursor,
    });
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

  /** B3 (G3): recenzent zamienia kierunek proposala z detektora sprzeczności — target archiwizacji zmienia się
   * wyłącznie na drugą stronę z `affectedIds`. Zapis w `edited_payload` + audyt; approve idzie zwykłą ścieżką. */
  @Post(':id/swap-direction')
  async swapDirection(
    @Param('id', new ZodValidationPipe(opaqueId)) id: string,
    @Body(new ZodValidationPipe(swapDirectionBody)) body: SwapDirectionBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<SwapDirectionResult> {
    return this.proposals.swapConflictDirection(id, body.memoryId, { actor: DASHBOARD_ACTOR });
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
