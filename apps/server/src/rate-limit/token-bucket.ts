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

  /** Czas (ms) od ostatniego `tryConsume`. Bucket bezczynny ≥ pełny-refill jest już dopełniony do
   * `capacity`, więc jest nieodróżnialny od świeżo utworzonego — bezpieczny do usunięcia (eviction). */
  idleMs(nowMs: number = Date.now()): number {
    return nowMs - this.lastRefillMs;
  }
}

/**
 * Sprząta mapę bucketów in-memory z wpisów bezczynnych ≥ `ttlMs` (patrz `idleMs` — taki bucket i tak
 * jest w pełni dopełniony, więc usunięcie jest behawioralnie neutralne). Wołane oportunistycznie przez
 * serwisy rate-limitu/throttlingu, gdy mapa urośnie — bez timerów (spójne z filozofią "bez timerów"
 * tego pliku). Zwraca liczbę usuniętych wpisów. Domyślny `now` w idleMs → jeden odczyt zegara na wpis;
 * przekaż `nowMs` gdy testujesz deterministycznie. */
export function sweepStaleBuckets(
  buckets: Map<string, TokenBucket>,
  ttlMs: number,
  nowMs: number = Date.now(),
): number {
  let removed = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.idleMs(nowMs) >= ttlMs) {
      buckets.delete(key);
      removed += 1;
    }
  }
  return removed;
}
