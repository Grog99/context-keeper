import type { EmbeddingProvider } from './embedding-provider';

// TEI (huggingface/text-embeddings-inference) natywny kontrakt: POST /embed {inputs: string[]}
// -> number[][], jedno wywołanie na batch (bez per-text roundtripów). Serwuje zarówno preset
// `multilingual` (bge-m3) jak i `english` (bge-small-en-v1.5) — sam kontener różni model, nie kod.
const DEFAULT_TIMEOUT_MS = 5000;

export class LocalTeiProvider implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    readonly model: string,
    readonly dim: number,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`TEI embed http ${res.status}`);
    }
    const vectors = (await res.json()) as number[][];
    for (const vector of vectors) {
      if (vector.length !== this.dim) {
        throw new Error(`TEI embed dim mismatch: expected ${this.dim}, got ${vector.length}`);
      }
    }
    return vectors;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
