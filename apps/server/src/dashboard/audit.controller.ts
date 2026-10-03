import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditLogRow } from '../db/schema';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { auditListQuery, type AuditListQuery } from './dashboard.schemas';
import { DashboardErrorFilter } from './dashboard-error.filter';

/** FR-D4 Audyt — tabela zdarzeń filtrowalna po `event_type`/zakresie czasu/projekcie.
 *
 * Walidacja query (tech-review #3, roadmap v1.4) — `auditListQuery` (`dashboard.schemas.ts`)
 * parsuje `from`/`to`/`cursor` (ISO), `limit` (1..`AUDIT_QUERY_MAX_LIMIT`) i `eventType`
 * (`auditEventType.enumValues`); `from`/`to` docierają do serwisu już jako `Date`, `limit` jako
 * `number` — bez `new Date(...)`/`Number.parseInt(...)` inline w kontrolerze. */
@Controller('api/audit')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(auditListQuery)) query: AuditListQuery,
  ): Promise<AuditLogRow[]> {
    return this.audit.query({ ...query });
  }
}
