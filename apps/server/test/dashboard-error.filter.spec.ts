import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DashboardErrorFilter } from '../src/dashboard/dashboard-error.filter';
import { PurgeError } from '../src/purge/purge.errors';

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
}

/** Jak `ctxFor` w `csrf.guard.spec.ts` — stub minimalny, tylko to czego dotyka `catch()`:
 * `host.switchToHttp().getResponse()` zwracający chainable `status().json()`. */
function hostCapturing(captured: CapturedResponse): ArgumentsHost {
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
    },
  };
  return {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

/** `PurgeError` → HTTP (roadmap v1.1 — bez tej gałęzi spadałby na domyślny handler Nesta jako 500,
 * §Ryzyka planu dashboard-nightly-purge / plan §2 krok 3). */
describe('DashboardErrorFilter — mapowanie PurgeError na HTTP', () => {
  const filter = new DashboardErrorFilter();

  it('PurgeError("not_found") -> 404', () => {
    const captured: CapturedResponse = {};
    filter.catch(new PurgeError('not_found', 'Pamięć nie istnieje: mem_1'), hostCapturing(captured));

    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ code: 'not_found', message: 'Pamięć nie istnieje: mem_1' });
  });

  it('PurgeError("already_purged") -> 409', () => {
    const captured: CapturedResponse = {};
    filter.catch(new PurgeError('already_purged', 'Pamięć mem_1 jest już wymazana'), hostCapturing(captured));

    expect(captured.statusCode).toBe(409);
    expect(captured.body).toEqual({ code: 'already_purged', message: 'Pamięć mem_1 jest już wymazana' });
  });

  it('PurgeError("validation_error") -> 400', () => {
    const captured: CapturedResponse = {};
    filter.catch(new PurgeError('validation_error', '--reason jest wymagany'), hostCapturing(captured));

    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ code: 'validation_error', message: '--reason jest wymagany' });
  });
});
