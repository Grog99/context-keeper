import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CsrfGuard } from '../src/dashboard/auth/csrf.guard';

interface FakeRequest {
  method: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
}

function ctxFor(req: Partial<FakeRequest>): ExecutionContext {
  const request: FakeRequest = { method: 'GET', headers: {}, cookies: {}, ...req };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();

  it('GET (nie-mutujące) -> zawsze przepuszcza, nawet bez tokenów/nagłówków', () => {
    expect(guard.canActivate(ctxFor({ method: 'GET' }))).toBe(true);
  });

  it('POST z poprawnym double-submit (cookie === header) i same-origin -> przepuszcza', () => {
    const ctx = ctxFor({
      method: 'POST',
      headers: { host: 'app.local', origin: 'https://app.local', [CSRF_HEADER_NAME]: 'tok123' },
      cookies: { [CSRF_COOKIE_NAME]: 'tok123' },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('POST bez nagłówka X-CSRF-Token -> 403', () => {
    const ctx = ctxFor({ method: 'POST', cookies: { [CSRF_COOKIE_NAME]: 'tok123' } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('POST bez cookie ck_csrf (tylko nagłówek) -> 403', () => {
    const ctx = ctxFor({ method: 'POST', headers: { [CSRF_HEADER_NAME]: 'tok123' } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('POST z niezgodnym tokenem (header != cookie) -> 403', () => {
    const ctx = ctxFor({
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: 'wrong' },
      cookies: { [CSRF_COOKIE_NAME]: 'tok123' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('POST z Sec-Fetch-Site=cross-site -> 403 nawet z poprawnym double-submit', () => {
    const ctx = ctxFor({
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', [CSRF_HEADER_NAME]: 'tok123' },
      cookies: { [CSRF_COOKIE_NAME]: 'tok123' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('POST z Sec-Fetch-Site=same-origin -> nie blokuje na etapie same-origin', () => {
    const ctx = ctxFor({
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', [CSRF_HEADER_NAME]: 'tok123' },
      cookies: { [CSRF_COOKIE_NAME]: 'tok123' },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('POST z Origin cross-site (host się nie zgadza) -> 403', () => {
    const ctx = ctxFor({
      method: 'POST',
      headers: { host: 'app.local', origin: 'https://evil.example', [CSRF_HEADER_NAME]: 'tok123' },
      cookies: { [CSRF_COOKIE_NAME]: 'tok123' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('PATCH/DELETE też traktowane jako mutujące', () => {
    expect(() => guard.canActivate(ctxFor({ method: 'PATCH', cookies: { [CSRF_COOKIE_NAME]: 'x' } }))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(ctxFor({ method: 'DELETE', cookies: { [CSRF_COOKIE_NAME]: 'x' } }))).toThrow(
      ForbiddenException,
    );
  });
});
