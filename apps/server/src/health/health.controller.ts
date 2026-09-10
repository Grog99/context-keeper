import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.tokens';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embeddings/embedding-provider';

export const HEALTH_CACHE_MS = 5_000;

type HealthBody = { status: string; db: string; embeddings: string };

/**
 * `/health` dla proxy/Compose (NFR-4).
 * DB down → 503 (unhealthy) — app naprawdę nie działa bez bazy.
 * Provider embeddingów down → `degraded` przy 200 (§7 tech-stack: search ma fail-open FTS-only,
 * więc app zostaje „up" — proxy/Compose nie powinien restartować kontenera za martwy sidecar TEI).
 */
@Controller('health')
export class HealthController {
  // Endpoint jest publiczny i bez auth na porcie MCP: wynik (wraz z in-flight probe) współdzielony
  // przez HEALTH_CACHE_MS, żeby flood nie wyczerpał puli `pg` ani nie zapchał sidecara TEI.
  private cached: { at: number; body: Promise<HealthBody | null> } | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  @Get()
  async check(): Promise<HealthBody> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at >= HEALTH_CACHE_MS) {
      this.cached = { at: now, body: this.probe() };
    }
    const body = await this.cached.body;
    if (!body) {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
    return body;
  }

  private async probe(): Promise<HealthBody | null> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      return null;
    }

    const embeddingsUp = await this.embeddingProvider.health().catch(() => false);
    return {
      status: embeddingsUp ? 'ok' : 'degraded',
      db: 'up',
      embeddings: embeddingsUp ? 'up' : 'down',
    };
  }
}
