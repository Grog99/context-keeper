import { ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { HEALTH_CACHE_MS, HealthController } from '../src/health/health.controller';

function setup(opts: { dbUp?: boolean; embeddingsUp?: boolean } = {}) {
  const state = { dbUp: opts.dbUp ?? true, embeddingsUp: opts.embeddingsUp ?? true };
  const calls = { db: 0, embeddings: 0 };
  const pool = {
    query: async () => {
      calls.db++;
      if (!state.dbUp) throw new Error('db down');
      return { rows: [] };
    },
  } as unknown as Pool;
  const provider = {
    health: async () => {
      calls.embeddings++;
      return state.embeddingsUp;
    },
  } as unknown as EmbeddingProvider;
  return { controller: new HealthController(pool, provider), calls, state };
}

describe('HealthController — cache wyniku', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flood równoległych requestów robi jeden probe DB i jeden TEI', async () => {
    const { controller, calls } = setup();

    const results = await Promise.all(Array.from({ length: 100 }, () => controller.check()));

    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(calls).toEqual({ db: 1, embeddings: 1 });
  });

  it('w oknie cache zwraca zapamiętany wynik, po jego upływie sprawdza ponownie', async () => {
    const { controller, calls, state } = setup();
    await controller.check();

    state.embeddingsUp = false;
    vi.advanceTimersByTime(HEALTH_CACHE_MS - 1);
    expect((await controller.check()).status).toBe('ok');
    expect(calls.db).toBe(1);

    vi.advanceTimersByTime(1);
    expect(await controller.check()).toEqual({ status: 'degraded', db: 'up', embeddings: 'down' });
    expect(calls.db).toBe(2);
  });

  it('DB down → 503 dla każdego requestu w oknie cache, bez ponownego pytania bazy', async () => {
    const { controller, calls } = setup({ dbUp: false });

    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(calls).toEqual({ db: 1, embeddings: 0 });
  });
});
