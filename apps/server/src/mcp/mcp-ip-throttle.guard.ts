import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../config/config.service';
import { RateLimitedException } from '../rate-limit/rate-limited.exception';
import { sweepStaleBuckets, TokenBucket } from '../rate-limit/token-bucket';

// Bucket per-minutowy jest w pełni dopełniony po 60s bezczynności → wtedy bezpieczny do usunięcia.
const BUCKET_TTL_MS = 60_000;
// Klucz to IP (pre-auth, dowolny klient) — bez sweepu mapa rosłaby przy rotacji adresów.
const SWEEP_THRESHOLD = 50_000;

/**
 * Throttle PRE-AUTH per IP na /mcp (C1 review bezpieczeństwa). Musi biec PRZED `BearerGuard`, żeby
 * ograniczyć nieuwierzytelniony DB-load: bez tego napastnik może zalewać /mcp dobrze sformatowanymi,
 * ale nieważnymi tokenami — każdy odpala lookup `token_hash` w bazie. Guard token-bucket in-memory,
 * jak `RateLimiterService`/`LoginThrottleService` (single-instance trade-off świadomy w v1).
 *
 * `req.ip` honoruje ustawienie `trust proxy` Expressa (sterowane `TRUST_PROXY`, main.ts). Za zaufanym,
 * jedynym proxy-ingres (`TRUST_PROXY=true`) daje granularność per realny klient; bez tego wszystkie
 * żądania mają IP proxy → limit degraduje się do coarse per-instancja (nadal poprawny backstop na
 * łączny nieuwierzytelniony ruch). Przekroczenie → 429 + `Retry-After` (jak limity per-token), przez
 * `RateLimitedException` łapaną przez `RateLimitExceptionFilter` na kontrolerze.
 */
@Injectable()
export class McpIpThrottleGuard implements CanActivate {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly config: AppConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';

    let bucket = this.buckets.get(ip);
    if (!bucket) {
      if (this.buckets.size >= SWEEP_THRESHOLD) sweepStaleBuckets(this.buckets, BUCKET_TTL_MS);
      const limitPerMin = this.config.get('RATE_LIMIT_MCP_IP_PER_MIN');
      bucket = new TokenBucket(limitPerMin, limitPerMin / 60_000);
      this.buckets.set(ip, bucket);
    }

    const result = bucket.tryConsume();
    if (!result.allowed) {
      throw new RateLimitedException(Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
    }
    return true;
  }
}
