import { describe, expect, it } from 'vitest';
import type { AuditService } from '../src/audit/audit.service';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import { MetricsController } from '../src/dashboard/metrics.controller';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { HealthStubEmbeddingProvider } from './helpers/fakes';

/** Minimalny stub `Database` — `MetricsController.get()` woła tylko `select().from().where()`
 * na `proposals` po głębokość kolejki. */
function fakeDb(queueDepth: number): Database {
  return {
    select: () => ({
      from: () => ({
        where: async () => [{ count: queueDepth }],
      }),
    }),
  } as unknown as Database;
}

function fakeAudit(secretBlocked24h = 0): AuditService {
  return {
    countSince: async () => secretBlocked24h,
    latestByEventType: async () => null,
  } as unknown as AuditService;
}

function buildEmbedding(provider: EmbeddingProvider): EmbeddingService {
  const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
  return new EmbeddingService(provider, config);
}

describe('MetricsController.get — embedding.latencyMs (FR-D7/NFR-4)', () => {
  it('zwraca latencyMs zmierzone przez EmbeddingService.health() dla zdrowego providera', async () => {
    const provider = new HealthStubEmbeddingProvider('test-model');
    provider.healthDelayMs = 15;
    const embedding = buildEmbedding(provider);
    const controller = new MetricsController(fakeDb(0), fakeAudit(), embedding);

    const result = await controller.get();

    expect(result.embedding.status).toBe('up');
    expect(result.embedding.model).toBe('test-model');
    expect(result.embedding.latencyMs).not.toBeNull();
    expect(result.embedding.latencyMs!).toBeGreaterThanOrEqual(10);
  });

  it('zwraca latencyMs (nie null) nawet gdy provider.health() rzuca (status "down")', async () => {
    const provider = new HealthStubEmbeddingProvider('test-model');
    provider.healthResult = 'throw';
    const embedding = buildEmbedding(provider);
    const controller = new MetricsController(fakeDb(0), fakeAudit(), embedding);

    const result = await controller.get();

    expect(result.embedding.status).toBe('down');
    expect(result.embedding.latencyMs).not.toBeNull();
    expect(result.embedding.latencyMs!).toBeGreaterThanOrEqual(0);
  });

  it('latencyMs pochodzi z pomiaru wykonanego wewnątrz get() (świeży EmbeddingService startuje z null)', async () => {
    const provider = new HealthStubEmbeddingProvider('m');
    const embedding = buildEmbedding(provider);
    expect(embedding.healthLatencyMs).toBeNull();

    const controller = new MetricsController(fakeDb(0), fakeAudit(), embedding);
    const result = await controller.get();

    expect(result.embedding.latencyMs).not.toBeNull();
    expect(result.embedding.latencyMs).toBe(embedding.healthLatencyMs);
  });
});
