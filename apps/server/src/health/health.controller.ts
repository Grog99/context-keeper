import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.tokens';

/**
 * `/health` dla proxy/Compose (NFR-4).
 * v1 (Fundament): liveness + ping DB. DB down → 503 (unhealthy).
 * Faza 3 dołoży zdrowie providera embeddingów jako `degraded` (nie unhealthy — app zostaje „up").
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async check(): Promise<{ status: string; db: string }> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
    return { status: 'ok', db: 'up' };
  }
}
