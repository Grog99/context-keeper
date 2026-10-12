import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginThrottleService } from '../src/dashboard/auth/login-throttle.service';

// Kontrakt throttla logowania (§10 ryzyka planu Fazy 5): 5 prób na okno 5 minut per IP.
const ATTEMPTS = 5;
const WINDOW_MS = 5 * 60_000;

function exhaust(throttle: LoginThrottleService, ip: string): void {
  for (let i = 0; i < ATTEMPTS; i++) {
    expect(throttle.tryConsume(ip)).toEqual({ allowed: true });
  }
}

describe('LoginThrottleService — throttle prób logowania per IP (tech-review #12)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('5 prób przechodzi, 6. odrzucona z retryAfterSec ≥ 1', () => {
    const throttle = new LoginThrottleService();
    exhaust(throttle, '198.51.100.1');

    const sixth = throttle.tryConsume('198.51.100.1');
    expect(sixth.allowed).toBe(false);
    if (sixth.allowed) return;
    expect(sixth.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('drugi IP ma własny budżet', () => {
    const throttle = new LoginThrottleService();
    exhaust(throttle, '198.51.100.1');
    expect(throttle.tryConsume('198.51.100.1').allowed).toBe(false);

    expect(throttle.tryConsume('198.51.100.2')).toEqual({ allowed: true });
  });

  it('po upływie okna próby wracają', () => {
    const throttle = new LoginThrottleService();
    exhaust(throttle, '198.51.100.1');
    expect(throttle.tryConsume('198.51.100.1').allowed).toBe(false);

    vi.advanceTimersByTime(WINDOW_MS);

    exhaust(throttle, '198.51.100.1');
  });
});
