import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/common/errors';
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

  /** `ZodValidationPipe` (tech-review #3, roadmap v1.4) rzuca dokładnie ten sam `ToolError`, który
   * już był mapowany na 400 dla walidacji serwisów (`TOOL_STATUS['validation_error']`) — ten test
   * dokumentuje, że pipe nie potrzebował żadnej zmiany w filtrze, tylko nowego producenta błędu. */
  it('ToolError("validation_error") z ZodValidationPipe -> 400 {code, message}', () => {
    const captured: CapturedResponse = {};
    filter.catch(new ToolError('validation_error', 'Invalid input — query.kind: …'), hostCapturing(captured));

    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ code: 'validation_error', message: 'Invalid input — query.kind: …' });
  });
});

/** Roadmap v1.5 — kody scope'u projektu muszą mieć status HTTP (`Record<ToolErrorCode, …>`) i
 * przekazywać `details` w kopercie JSON. */
describe("DashboardErrorFilter — kody scope'u projektu (v1.5)", () => {
  const filter = new DashboardErrorFilter();

  it.each([
    ['project_required', 400],
    ['project_not_found', 404],
    ['project_pending', 409],
    ['project_forbidden', 403],
  ] as const)('ToolError("%s") -> %i', (code, status) => {
    const captured: CapturedResponse = {};
    filter.catch(new ToolError(code, 'm'), hostCapturing(captured));

    expect(captured.statusCode).toBe(status);
    expect(captured.body).toEqual({ code, message: 'm' });
  });

  it('przekazuje details w kopercie JSON', () => {
    const captured: CapturedResponse = {};
    const projects = [{ slug: 'alpha', name: 'Alpha' }];
    filter.catch(new ToolError('project_not_found', 'm', { projects }), hostCapturing(captured));

    expect(captured.body).toEqual({ code: 'project_not_found', message: 'm', details: { projects } });
  });
});
