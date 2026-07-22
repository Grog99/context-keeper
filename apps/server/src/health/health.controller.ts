import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.tokens';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embeddings/embedding-provider';

/**
 * `/health` dla proxy/Compose (NFR-4).
 * DB down → 503 (unhealthy) — app naprawdę nie działa bez bazy.
 * Provider embeddingów down → `degraded` przy 200 (§7 tech-stack: search ma fail-open FTS-only,
 * więc app zostaje „up" — proxy/Compose nie powinien restartować kontenera za martwy sidecar TEI).
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  @Get()
  async check(): Promise<{ status: string; db: string; embeddings: string }> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }

    const embeddingsUp = await this.embeddingProvider.health().catch(() => false);
    return {
      status: embeddingsUp ? 'ok' : 'degraded',
      db: 'up',
      embeddings: embeddingsUp ? 'up' : 'down',
    };
  }
}
