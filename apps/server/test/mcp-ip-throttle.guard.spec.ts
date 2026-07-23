import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../src/config/config.service';
import { McpIpThrottleGuard } from '../src/mcp/mcp-ip-throttle.guard';
import { RateLimitedException } from '../src/rate-limit/rate-limited.exception';

function configWithLimit(perMin: number): AppConfigService {
  return { get: () => perMin } as unknown as AppConfigService;
}

function ctxForIp(ip: string | undefined, remoteAddress = '203.0.113.9'): ExecutionContext {
  const request = { ip, socket: { remoteAddress } };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe('McpIpThrottleGuard', () => {
  it('przepuszcza do limitu, potem rzuca 429 (RateLimitedException) dla tego samego IP', () => {
    const guard = new McpIpThrottleGuard(configWithLimit(2));
    expect(guard.canActivate(ctxForIp('198.51.100.1'))).toBe(true);
    expect(guard.canActivate(ctxForIp('198.51.100.1'))).toBe(true);
    expect(() => guard.canActivate(ctxForIp('198.51.100.1'))).toThrow(RateLimitedException);
  });

  it('bucket jest per-IP — inny IP ma własny budżet', () => {
    const guard = new McpIpThrottleGuard(configWithLimit(1));
    expect(guard.canActivate(ctxForIp('198.51.100.1'))).toBe(true);
    expect(() => guard.canActivate(ctxForIp('198.51.100.1'))).toThrow(RateLimitedException);
    // Drugi adres nietknięty limitem pierwszego.
    expect(guard.canActivate(ctxForIp('198.51.100.2'))).toBe(true);
  });

  it('gdy brak req.ip (trust proxy off / brak) spada na socket.remoteAddress', () => {
    const guard = new McpIpThrottleGuard(configWithLimit(1));
    expect(guard.canActivate(ctxForIp(undefined, '10.1.2.3'))).toBe(true);
    // Ten sam remoteAddress → ten sam bucket → drugie żądanie odrzucone.
    expect(() => guard.canActivate(ctxForIp(undefined, '10.1.2.3'))).toThrow(RateLimitedException);
  });

  it('RateLimitedException niesie Retry-After >= 1s', () => {
    const guard = new McpIpThrottleGuard(configWithLimit(1));
    guard.canActivate(ctxForIp('198.51.100.7'));
    try {
      guard.canActivate(ctxForIp('198.51.100.7'));
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedException);
      expect((err as RateLimitedException).retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });
});
