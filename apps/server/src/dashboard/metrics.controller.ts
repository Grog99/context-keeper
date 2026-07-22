import { Controller, Get, Inject, UseFilters, UseGuards } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { DB, type Database } from '../db/db.tokens';
import { proposals } from '../db/schema';
import { EmbeddingService } from '../embeddings/embedding.service';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DashboardErrorFilter } from './dashboard-error.filter';

const SECRET_BLOCKED_WINDOW_MS = 24 * 60 * 60_000;

export interface DashboardMetrics {
  queueDepth: number;
  embedding: { status: 'up' | 'down'; model: string };
  secretBlocked24h: number;
  /** `null` = "brak danych" po stronie SPA — nocny job to Faza 6, `audit_log` nie ma jeszcze
   * zdarzeń `nightly_run` w v1 (§Ryzyka planu). */
  nightlyRun: { at: string; metadata: Record<string, unknown> | null } | null;
}

/**
 * FR-D7 Metryki / health strip (§9.0 design-systemu, P1/P7). `GET /api/projects` (istniejący
 * kontroler) podwójnie służy jako lista dla `ContextSwitcher` — bez osobnego `/api/context`
 * (plan explicitnie dopuszcza tę opcję).
 */
@Controller('api/metrics')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class MetricsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly embedding: EmbeddingService,
  ) {}

  @Get()
  async get(): Promise<DashboardMetrics> {
    const [queueDepthRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(proposals)
      .where(eq(proposals.status, 'pending'));

    const [embeddingUp, secretBlocked24h, nightlyRun] = await Promise.all([
      this.embedding.health(),
      this.audit.countSince('secret_blocked', new Date(Date.now() - SECRET_BLOCKED_WINDOW_MS)),
      this.audit.latestByEventType('nightly_run'),
    ]);

    return {
      queueDepth: queueDepthRow?.count ?? 0,
      embedding: { status: embeddingUp ? 'up' : 'down', model: this.embedding.model },
      secretBlocked24h,
      nightlyRun: nightlyRun
        ? {
            at: nightlyRun.createdAt.toISOString(),
            metadata: (nightlyRun.metadata as Record<string, unknown> | null) ?? null,
          }
        : null,
    };
  }
}
