import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../src/config/config.service';
import { AuthController } from '../src/dashboard/auth/auth.controller';
import type { LoginThrottleService, ThrottleResult } from '../src/dashboard/auth/login-throttle.service';

const env: Record<string, unknown> = {
  DASHBOARD_PASSWORD: 'poprawne-haslo',
  SESSION_SECRET: 'sekret-testowy',
  SESSION_TTL_HOURS: 12,
  DASHBOARD_COOKIE_NAME: 'ck_session',
};

/** Atrapa configu notująca każdy odczytany klucz — dowód, że ścieżka 429 nie czyta hasła. */
function fakeConfig() {
  const asked: string[] = [];
  const config = {
    asked,
    get(key: string): unknown {
      asked.push(key);
      return env[key];
    },
  };
  return { asked, config: config as unknown as AppConfigService };
}

/** Atrapa throttla z ustalonym werdyktem, notująca klucz bucketu. */
function fakeThrottle(verdict: ThrottleResult) {
  const seen: string[] = [];
  const throttle = {
    seen,
    tryConsume(ip: string): ThrottleResult {
      seen.push(ip);
      return verdict;
    },
  };
  return { seen, throttle: throttle as unknown as LoginThrottleService };
}

function fakeReq(password: string, ip: string | undefined, remoteAddress = '203.0.113.9'): Request {
  return { body: { password }, ip, socket: { remoteAddress } } as unknown as Request;
}

function fakeRes() {
  const state = {
    statusCode: undefined as number | undefined,
    headers: {} as Record<string, string>,
    cookies: [] as { name: string; value: string }[],
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return this;
    },
    cookie(name: string, value: string) {
      state.cookies.push({ name, value });
      return this;
    },
  };
  return { state, res: res as unknown as Response };
}

const DENY: ThrottleResult = { allowed: false, retryAfterSec: 42 };

describe('AuthController.login — throttle przed sprawdzeniem hasła (tech-review #12)', () => {
  it.each([
    ['błędnego', 'zle-haslo'],
    ['poprawnego', 'poprawne-haslo'],
  ])('wyczerpany limit → 429 + Retry-After dla %s hasła, hasło nieczytane', (_label, password) => {
    const { asked, config } = fakeConfig();
    const { throttle } = fakeThrottle(DENY);
    const controller = new AuthController(config, throttle);
    const { state, res } = fakeRes();

    const result = controller.login(fakeReq(password, '198.51.100.1'), res);

    expect(result).toEqual({ authenticated: false });
    expect(state.statusCode).toBe(429);
    expect(state.headers['retry-after']).toBe('42');
    expect(state.cookies).toEqual([]);
    expect(asked).not.toContain('DASHBOARD_PASSWORD');
  });

  it('klucz bucketu: bez req.ip → socket.remoteAddress, z req.ip → req.ip', () => {
    const { config } = fakeConfig();

    const withoutIp = fakeThrottle(DENY);
    new AuthController(config, withoutIp.throttle).login(fakeReq('zle-haslo', undefined, '10.1.2.3'), fakeRes().res);
    expect(withoutIp.seen).toEqual(['10.1.2.3']);

    const withIp = fakeThrottle(DENY);
    new AuthController(config, withIp.throttle).login(fakeReq('zle-haslo', '198.51.100.1', '10.1.2.3'), fakeRes().res);
    expect(withIp.seen).toEqual(['198.51.100.1']);
  });
});
