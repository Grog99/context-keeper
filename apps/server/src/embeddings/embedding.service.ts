import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import type { MemoryKind } from '../db/schema/enums';
import { chunk, type MemoryChunk } from './chunker';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding-provider';

export interface EmbeddedChunk extends MemoryChunk {
  vector: number[];
}

export interface EmbedMemoryResult {
  model: string;
  chunks: EmbeddedChunk[];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Formatuje wektor JS jako literal pgvector (`'[0.1,0.2,...]'`) do wklejenia w surowe SQL
 * (`<=>`/ORDER BY poza kolumną drizzle — kolumna sama serializuje przez JSON.stringify na insert,
 * ale to nie dotyczy wyrażeń w WHERE/ORDER BY budowanych ręcznie w `memory.service.ts`). */
export function toPgVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Warstwa embeddingów nad providerem (§6/§7 tech-stack): chunking + wywołanie providera, w dwóch
 * reżimach błędów dla różnych wołających:
 * - `embedChunks` rzuca — wołający (np. `reembed` CLI) sam decyduje, czy zalogować i kontynuować.
 * - `embedQuery` / `embedMemoryBestEffort` łykają błąd/timeout i zwracają `null` — fail-open na
 *   ścieżkach search/save, żeby awaria providera nigdy nie psuła istniejącego kontraktu
 *   (FTS-only search, proposal-zawsze-powstaje przy save).
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private lastHealthLatencyMs: number | null = null;

  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    private readonly config: AppConfigService,
  ) {}

  get model(): string {
    return this.provider.model;
  }

  get dim(): number {
    return this.provider.dim;
  }

  /** Latencja ostatniego `health()` (FR-D7/NFR-4) — `null` dopóki `health()` nie zostanie
   * wywołane choć raz (np. świeży proces przed pierwszym pollem `MetricsController`). */
  get healthLatencyMs(): number | null {
    return this.lastHealthLatencyMs;
  }

  async health(): Promise<boolean> {
    const startedAt = Date.now();
    try {
      return await this.provider.health();
    } catch {
      return false;
    } finally {
      this.lastHealthLatencyMs = Date.now() - startedAt;
    }
  }

  /** Fail-open: `null` zamiast rzuconego błędu/timeoutu — wołający (search) pomija ramię wektorowe. */
  async embedQuery(query: string): Promise<number[] | null> {
    try {
      const timeoutMs = this.config.get('EMBEDDING_QUERY_TIMEOUT_MS');
      const [vector] = await withTimeout(this.provider.embed([query]), timeoutMs);
      return vector ?? null;
    } catch (err) {
      this.logger.warn(`embedQuery fail-open (search FTS-only): ${errMessage(err)}`);
      return null;
    }
  }

  /** Chunkuje + embeduje BEZ przechwytywania błędów — dla wołających, które same zarządzają
   * fail-open (reembed CLI loguje i kontynuuje per-memory zamiast łykać cicho tutaj). */
  async embedChunks(
    kind: MemoryKind,
    header: string,
    body: string,
    tags: string[],
  ): Promise<EmbedMemoryResult> {
    const chunks = chunk(kind, header, body, tags);
    const vectors = await this.provider.embed(chunks.map((c) => c.text));
    return {
      model: this.provider.model,
      chunks: chunks.map((c, i) => ({ ...c, vector: vectors[i] })),
    };
  }

  /** Fail-open wrapper dla save/devSeed: budżet czasu + swallow -> `null` (best-effort — embedding
   * nigdy nie blokuje proposala, §6 tech-stack). */
  async embedMemoryBestEffort(
    kind: MemoryKind,
    header: string,
    body: string,
    tags: string[],
    timeoutMs = this.config.get('EMBEDDING_SAVE_TIMEOUT_MS'),
  ): Promise<EmbedMemoryResult | null> {
    try {
      return await withTimeout(this.embedChunks(kind, header, body, tags), timeoutMs);
    } catch (err) {
      this.logger.warn(`embedMemoryBestEffort fail-open (staging embedding skipped): ${errMessage(err)}`);
      return null;
    }
  }
}
