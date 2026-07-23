import { describe, expect, it } from 'vitest';
import { sweepStaleBuckets, TokenBucket } from '../src/rate-limit/token-bucket';

describe('TokenBucket', () => {
  it('zużywa do pojemności, potem odrzuca z retryAfterMs > 0 (czas zamrożony)', () => {
    const bucket = new TokenBucket(2, 2 / 60_000);
    expect(bucket.tryConsume(0).allowed).toBe(true);
    expect(bucket.tryConsume(0).allowed).toBe(true);
    const denied = bucket.tryConsume(0);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('dopełnia leniwie wraz z upływem czasu', () => {
    const bucket = new TokenBucket(1, 1 / 60_000); // 1/min
    expect(bucket.tryConsume(0).allowed).toBe(true);
    expect(bucket.tryConsume(0).allowed).toBe(false); // pusty
    expect(bucket.tryConsume(60_000).allowed).toBe(true); // po minucie znów pełny
  });

  it('idleMs = czas od ostatniego tryConsume', () => {
    const bucket = new TokenBucket(5, 5 / 60_000);
    bucket.tryConsume(1_000);
    expect(bucket.idleMs(1_000)).toBe(0);
    expect(bucket.idleMs(61_000)).toBe(60_000);
  });
});

describe('sweepStaleBuckets', () => {
  it('usuwa bucket bezczynny >= ttl, zostawia świeży, zwraca liczbę usuniętych', () => {
    const fresh = new TokenBucket(5, 5 / 60_000);
    fresh.tryConsume(10_000); // lastRefill = 10_000
    const stale = new TokenBucket(5, 5 / 60_000);
    stale.tryConsume(0); // lastRefill = 0
    const map = new Map([
      ['fresh', fresh],
      ['stale', stale],
    ]);

    // now=61_000: fresh idle=51_000 (<60_000 → zostaje), stale idle=61_000 (>=60_000 → usunięty)
    const removed = sweepStaleBuckets(map, 60_000, 61_000);

    expect(removed).toBe(1);
    expect(map.has('fresh')).toBe(true);
    expect(map.has('stale')).toBe(false);
  });

  it('nic nie usuwa gdy wszystkie buckety świeże', () => {
    const b = new TokenBucket(5, 5 / 60_000);
    b.tryConsume(1_000);
    const map = new Map([['a', b]]);
    expect(sweepStaleBuckets(map, 60_000, 2_000)).toBe(0);
    expect(map.size).toBe(1);
  });
});
