export type TryConsumeResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Token-bucket ciągły (bez timerów) — dopełnianie liczone leniwie przy każdym `tryConsume`
 * na podstawie upływu czasu od ostatniego wywołania. Pojemność = limit/min; refill = limit/min/60000ms.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  tryConsume(nowMs: number = Date.now()): TryConsumeResult {
    const elapsed = Math.max(0, nowMs - this.lastRefillMs);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillMs = nowMs;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true };
    }
    const deficit = 1 - this.tokens;
    const retryAfterMs = Math.ceil(deficit / this.refillPerMs);
    return { allowed: false, retryAfterMs };
  }
}
