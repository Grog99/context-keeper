import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiEmbeddingProvider } from '../src/embeddings/api.provider';

function stubFetchOk(embeddingLength: number): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: new Array(embeddingLength).fill(0) }] }),
  }));
}

describe('ApiEmbeddingProvider (provider=api @ DIM=1024, Matryoshka via `dimensions`)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('embed() wysyła `dimensions` w body requestu (skrócenie 1536 -> 1024)', async () => {
    const fetchMock = stubFetchOk(1024);
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ApiEmbeddingProvider('https://api.example.com/embeddings', 'text-embedding-3-small', 1024, 'sk-test');
    const vectors = await provider.embed(['x']);

    expect(vectors).toEqual([new Array(1024).fill(0)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { input: string[]; model: string; dimensions: number };
    expect(body).toEqual({ input: ['x'], model: 'text-embedding-3-small', dimensions: 1024 });
  });

  it('zły length wektora dalej rzuca przez istniejący guard dim-mismatch', async () => {
    const fetchMock = stubFetchOk(1536); // API zwraca "surowy" wymiar zamiast skróconego 1024
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ApiEmbeddingProvider('https://api.example.com/embeddings', 'text-embedding-3-small', 1024, 'sk-test');

    await expect(provider.embed(['x'])).rejects.toThrow(/dim mismatch/i);
  });
});
