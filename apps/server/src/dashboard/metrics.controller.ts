import { Controller, Get, Inject, Query, UseFilters, UseGuards } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { DB, type Database } from '../db/db.tokens';
import { proposals } from '../db/schema';
import { EmbeddingService } from '../embeddings/embedding.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { emptyQuery } from './dashboard.schemas';
import { DashboardErrorFilter } from './dashboard-error.filter';

const SECRET_BLOCKED_WINDOW_MS = 24 * 60 * 60_000;

export interface DashboardMetrics {
  queueDepth: number;
  embedding: { status: 'up' | 'down'; model: string; latencyMs: number | null };
  secretBlocked24h: number;
  /** `null` = "brak danych" po stronie SPA — nocny job to Faza 6, `audit_log` nie ma jeszcze
   * zdarzeń `nightly_run` w v1 (§Ryzyka planu). */
  nightlyRun: { at: string; metadata: Record<string, unknown> | null } | null;
  /** Ostatni `backup_completed` (Faza 7) — `metadata.status` ('ok'/'failed') różnicuje wynik,
   * analogicznie do `nightlyRun`. */
  lastBackup: { at: string; metadata: Record<string, unknown> | null } | null;
}

/**
 * FR-D7 Metryki / health strip (§9.0 design-systemu, P1/P7). `GET /api/projects` (istniejący
 * kontroler) podwójnie służy jako lista dla `ContextSwitcher` — bez osobnego `/api/context`
 * (plan explicitnie dopuszcza tę opcję).
 *
 * Walidacja query (tech-review #3, roadmap v1.4, Q1 resolved "strict everywhere") — endpoint nie
 * przyjmuje żadnych filtrów, ale nieznany klucz query dalej jest 400, nie ciche zignorowanie.
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
  async get(
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<DashboardMetrics> {
    const [queueDepthRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(proposals)
      .where(eq(proposals.status, 'pending'));

    const [embeddingUp, secretBlocked24h, nightlyRun, lastBackup] = await Promise.all([
      this.embedding.health(),
      this.audit.countSince('secret_blocked', new Date(Date.now() - SECRET_BLOCKED_WINDOW_MS)),
      this.audit.latestByEventType('nightly_run'),
      this.audit.latestByEventType('backup_completed'),
    ]);

    return {
      queueDepth: queueDepthRow?.count ?? 0,
      embedding: {
        status: embeddingUp ? 'up' : 'down',
        model: this.embedding.model,
        latencyMs: this.embedding.healthLatencyMs,
      },
      secretBlocked24h,
      nightlyRun: nightlyRun
        ? {
            at: nightlyRun.createdAt.toISOString(),
            metadata: (nightlyRun.metadata as Record<string, unknown> | null) ?? null,
          }
        : null,
      lastBackup: lastBackup
        ? {
            at: lastBackup.createdAt.toISOString(),
            metadata: (lastBackup.metadata as Record<string, unknown> | null) ?? null,
          }
        : null,
    };
  }
}
