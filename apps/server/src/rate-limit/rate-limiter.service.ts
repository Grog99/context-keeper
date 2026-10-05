import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { sweepStaleBuckets, TokenBucket } from './token-bucket';

/** Narzędzia pamięci — klucz limitu `tokenId:projectId` (osobny budżet per projekt, v1.5 #17). */
export const MEMORY_TOOLS = ['search_memory', 'get_memory', 'save_memory'] as const;
/** Narzędzia tokenu konta (scope B) — klucz `tokenId:account`, bez projektu. */
export const ACCOUNT_TOOLS = ['list_projects', 'create_project'] as const;

export type RateLimitedTool = (typeof MEMORY_TOOLS)[number] | (typeof ACCOUNT_TOOLS)[number];

export type ConsumeResult = { allowed: true } | { allowed: false; retryAfterSec: number };

// Bucket per-minutowy jest w pełni dopełniony po 60s bezczynności → wtedy bezpieczny do usunięcia.
const BUCKET_TTL_MS = 60_000;
// Powyżej tylu wpisów robimy oportunistyczny sweep przy tworzeniu nowego bucketu (mapa jest
// ograniczona liczbą aktywnych par projekt×narzędzie, ale bez sweepu nigdy nie malała — C2).
const SWEEP_THRESHOLD = 10_000;

/**
 * Rate limiting per token × narzędzie (§10 tech-stack, NFR-3). Token-bucket **in-memory**,
 * single-instance — świadomy trade-off v1 (przeniesienie na Redis dopiero przy skalowaniu poziomym).
 *
 * Klucz bucketu (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") to `key` — token ID,
 * NIE `projectId`. Dawniej token==projekt (1:1), więc kluczowanie po projekcie było nieodróżnialne;
 * z N tokenami per projekt kluczowanie po projekcie dzieliłoby jeden budżet między wszystkich agentów
 * (drugi agent = połowa przepustowości pierwszego). Per-token matchuje udokumentowany zamiar
 * (tech-stack §10 "Rate limiting per-token") i jest drobnym zyskiem bezpieczeństwa — skompromitowany
 * token dostaje WŁASNY bucket, nie może zagłodzić legalnego agenta tym samym projektem.
 *
 * v1.5 (ticket #17): wołający składa `key` przez `rateLimitKey` (`mcp-rate-limit.guard.ts`) —
 * `tokenId:projectId` dla narzędzi pamięci (token konta ma osobny budżet w każdym projekcie, więc
 * zapętlony agent w jednym repo nie dusi pozostałych), `tokenId:account` dla narzędzi konta. Dla
 * tokenu projektowego (projekt stały) zachowanie bez zmian. Okno jest wyłącznie per-minutowe.
 */
@Injectable()
export class RateLimiterService {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly config: AppConfigService) {}

  tryConsume(key: string, tool: RateLimitedTool): ConsumeResult {
    const bucketKey = `${key}:${tool}`;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      if (this.buckets.size >= SWEEP_THRESHOLD) sweepStaleBuckets(this.buckets, BUCKET_TTL_MS);
      const limitPerMin = this.limitFor(tool);
      bucket = new TokenBucket(limitPerMin, limitPerMin / 60_000);
      this.buckets.set(bucketKey, bucket);
    }
    const result = bucket.tryConsume();
    if (result.allowed) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(result.retryAfterMs / 1000)) };
  }

  private limitFor(tool: RateLimitedTool): number {
    switch (tool) {
      case 'save_memory':
        return this.config.get('RATE_LIMIT_SAVE_PER_MIN');
      case 'search_memory':
        return this.config.get('RATE_LIMIT_SEARCH_PER_MIN');
      case 'get_memory':
        return this.config.get('RATE_LIMIT_GET_PER_MIN');
      case 'list_projects':
        return this.config.get('RATE_LIMIT_SEARCH_PER_MIN');
      case 'create_project':
        return this.config.get('RATE_LIMIT_CREATE_PROJECT_PER_MIN');
    }
  }
}
