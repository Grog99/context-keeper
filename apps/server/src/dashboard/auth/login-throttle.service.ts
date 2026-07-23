import { Injectable } from '@nestjs/common';
import { sweepStaleBuckets, TokenBucket } from '../../rate-limit/token-bucket';

const LOGIN_ATTEMPTS_PER_WINDOW = 5;
const WINDOW_MS = 5 * 60_000;
// Bucket jest w pełni dopełniony po WINDOW_MS bezczynności → wtedy bezpieczny do usunięcia.
// Klucz to IP (pre-auth), więc bez sweepu rotacja adresów rosłaby mapę bez ograniczeń (C2).
const SWEEP_THRESHOLD = 10_000;

export type ThrottleResult = { allowed: true } | { allowed: false; retryAfterSec: number };

/**
 * Throttle prób logowania per IP (§10 ryzyka planu — hasło dashboardu jest niskoentropijne,
 * spowolnij brute force). In-memory token-bucket, jak `RateLimiterService` (single-instance
 * trade-off świadomy w v1, patrz komentarz tam).
 */
@Injectable()
export class LoginThrottleService {
  private readonly buckets = new Map<string, TokenBucket>();

  tryConsume(ip: string): ThrottleResult {
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      if (this.buckets.size >= SWEEP_THRESHOLD) sweepStaleBuckets(this.buckets, WINDOW_MS);
      bucket = new TokenBucket(LOGIN_ATTEMPTS_PER_WINDOW, LOGIN_ATTEMPTS_PER_WINDOW / WINDOW_MS);
      this.buckets.set(ip, bucket);
    }
    const result = bucket.tryConsume();
    if (result.allowed) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(result.retryAfterMs / 1000)) };
  }
}
