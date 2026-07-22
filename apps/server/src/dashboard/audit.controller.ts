import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditEventType } from '../db/schema/enums';
import type { AuditLogRow } from '../db/schema';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DashboardErrorFilter } from './dashboard-error.filter';

/** FR-D4 Audyt — tabela zdarzeń filtrowalna po `event_type`/zakresie czasu/projekcie. */
@Controller('api/audit')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(
    @Query('eventType') eventType?: AuditEventType,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<AuditLogRow[]> {
    return this.audit.query({
      eventType,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      projectId,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      cursor,
    });
  }
}
