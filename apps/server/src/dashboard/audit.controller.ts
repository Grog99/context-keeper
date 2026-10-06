import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AuditService, type AuditPage } from '../audit/audit.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { auditListQuery, type AuditListQuery } from './dashboard.schemas';
import { DashboardErrorFilter } from './dashboard-error.filter';

/** FR-D4 Audyt — tabela zdarzeń filtrowalna po `event_type`/zakresie czasu/projekcie.
 *
 * Walidacja query (tech-review #3, roadmap v1.4) — `auditListQuery` (`dashboard.schemas.ts`)
 * parsuje `from`/`to` (ISO), `limit` (1..`AUDIT_QUERY_MAX_LIMIT`), `eventType`
 * (`auditEventType.enumValues`) i `cursor` (opaque keyset `(created_at, id)`, patrz
 * `keysetCursorQuery`); `from`/`to` docierają do serwisu już jako `Date`, `limit` jako `number`,
 * `cursor` jako `{ ts, id }`. Odpowiedź to `{ items, nextCursor }` (`nextCursor` = `null` na
 * ostatniej stronie). */
@Controller('api/audit')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(auditListQuery)) query: AuditListQuery,
  ): Promise<AuditPage> {
    return this.audit.query({ ...query });
  }
}
