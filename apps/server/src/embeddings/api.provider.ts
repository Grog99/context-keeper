import type { EmbeddingProvider } from './embedding-provider';

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Adapter zewnętrznego API embeddingów — kontrakt OpenAI `{input, model} -> data[].embedding`
 * (cel presetu `api`: `text-embedding-3-small`, 1536 wym.; Voyage i podobne API-compatible
 * providery pasują pod ten sam kształt). `apiKey` NIGDY nie trafia do logu ani treści błędu —
 * błędy HTTP niosą tylko status, błędy sieciowe tylko `err.message` (fetch nie wstrzykuje
 * nagłówków do komunikatu wyjątku).
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    readonly model: string,
    readonly dim: number,
    private readonly apiKey: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Embedding API http ${res.status}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    const vectors = json.data.map((d) => d.embedding);
    for (const vector of vectors) {
      if (vector.length !== this.dim) {
        throw new Error(`Embedding API dim mismatch: expected ${this.dim}, got ${vector.length}`);
      }
    }
    return vectors;
  }

  async health(): Promise<boolean> {
    try {
      await this.embed(['ping']);
      return true;
    } catch {
      return false;
    }
  }
}
