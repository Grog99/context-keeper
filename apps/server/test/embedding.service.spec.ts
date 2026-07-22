import { describe, expect, it } from 'vitest';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';

/** Jak `StubEmbeddingProvider` w innych integration specs — tu z kontrolowanym opóźnieniem
 * `health()`, żeby zmierzyć, czy `EmbeddingService.healthLatencyMs` faktycznie odzwierciedla
 * rzeczywisty czas providera (FR-D7/NFR-4), nie tylko jakąś stałą. */
class StubProvider implements EmbeddingProvider {
  readonly dim = 4;
  healthResult: boolean | 'throw' = true;
  healthDelayMs = 0;

  constructor(public model: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0, 0]);
  }

  async health(): Promise<boolean> {
    if (this.healthDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.healthDelayMs));
    }
    if (this.healthResult === 'throw') {
      throw new Error('StubProvider: symulowana awaria health-checku');
    }
    return this.healthResult;
  }
}

function buildService(provider: EmbeddingProvider): EmbeddingService {
  const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
  return new EmbeddingService(provider, config);
}

describe('EmbeddingService.healthLatencyMs (FR-D7/NFR-4 — latencja embeddingu w dashboardzie)', () => {
  it('przed pierwszym health() jest null', () => {
    const service = buildService(new StubProvider('m'));
    expect(service.healthLatencyMs).toBeNull();
  });

  it('po udanym health() ustawia nieujemną latencję zbliżoną do rzeczywistego opóźnienia providera', async () => {
    const provider = new StubProvider('m');
    provider.healthDelayMs = 20;
    const service = buildService(provider);

    const ok = await service.health();

    expect(ok).toBe(true);
    expect(service.healthLatencyMs).not.toBeNull();
    expect(service.healthLatencyMs!).toBeGreaterThanOrEqual(15);
  });

  it('gdy provider.health() rzuca, health() łyka błąd (false) ale i tak ustawia latencję', async () => {
    const provider = new StubProvider('m');
    provider.healthResult = 'throw';
    provider.healthDelayMs = 10;
    const service = buildService(provider);

    const ok = await service.health();

    expect(ok).toBe(false);
    expect(service.healthLatencyMs).not.toBeNull();
    expect(service.healthLatencyMs!).toBeGreaterThanOrEqual(5);
  });

  it('kolejne wywołanie health() nadpisuje poprzednią latencję świeżym pomiarem', async () => {
    const provider = new StubProvider('m');
    provider.healthDelayMs = 40;
    const service = buildService(provider);
    await service.health();
    const first = service.healthLatencyMs;

    provider.healthDelayMs = 0;
    await service.health();
    const second = service.healthLatencyMs;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!).toBeLessThan(first!);
  });
});
