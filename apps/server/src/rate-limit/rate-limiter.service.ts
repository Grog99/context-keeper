import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { TokenBucket } from './token-bucket';

export type RateLimitedTool = 'search_memory' | 'get_memory' | 'save_memory';

export type ConsumeResult = { allowed: true } | { allowed: false; retryAfterSec: number };

/**
 * Rate limiting per token × narzędzie (§10 tech-stack, NFR-3). Token-bucket **in-memory**,
 * single-instance — świadomy trade-off v1 (przeniesienie na Redis dopiero przy skalowaniu poziomym).
 */
@Injectable()
export class RateLimiterService {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly config: AppConfigService) {}

  tryConsume(projectId: string, tool: RateLimitedTool): ConsumeResult {
    const key = `${projectId}:${tool}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const limitPerMin = this.limitFor(tool);
      bucket = new TokenBucket(limitPerMin, limitPerMin / 60_000);
      this.buckets.set(key, bucket);
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
    }
  }
}
