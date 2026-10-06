import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../src/config/config.service';
import { McpRateLimitGuard, rateLimitKey } from '../src/mcp/mcp-rate-limit.guard';
import type { McpAuthContext, ProjectResolution, TokenScope } from '../src/projects/project-scope';
import { RateLimitedException } from '../src/rate-limit/rate-limited.exception';
import { RateLimiterService } from '../src/rate-limit/rate-limiter.service';

/** Config stub: każdy limit per-min z `limits` (domyślnie `fallback`). */
function config(limits: Record<string, number>, fallback = 100): AppConfigService {
  return { get: (key: string) => limits[key] ?? fallback } as unknown as AppConfigService;
}

function resolved(projectId: string): ProjectResolution {
  return { status: 'resolved', context: { projectId, projectName: projectId } };
}

function auth(tokenId: string, tokenScope: TokenScope, project: ProjectResolution): McpAuthContext {
  return { tokenId, tokenLabel: tokenId, tokenScope, project };
}

function ctxFor(mcpAuth: McpAuthContext | undefined, body: unknown): ExecutionContext {
  const request = { mcpAuth, body };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => undefined }),
  } as unknown as ExecutionContext;
}

const call = (tool: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool } });

describe('rateLimitKey (roadmap v1.5, ticket #17)', () => {
  it('narzędzia pamięci: tokenId:projectId', () => {
    expect(rateLimitKey(auth('tok_a', 'account', resolved('proj_x')), 'search_memory')).toBe('tok_a:proj_x');
    expect(rateLimitKey(auth('tok_a', 'project', resolved('proj_x')), 'save_memory')).toBe('tok_a:proj_x');
  });

  it('narzędzia konta: tokenId:account (niezależnie od projektu)', () => {
    expect(rateLimitKey(auth('tok_a', 'account', resolved('proj_x')), 'create_project')).toBe('tok_a:account');
    expect(
      rateLimitKey(auth('tok_a', 'account', { status: 'unresolved', reason: 'project_required' }), 'list_projects'),
    ).toBe('tok_a:account');
  });

  it('nierozwiązany projekt + narzędzie pamięci -> null (bez bucketu)', () => {
    expect(
      rateLimitKey(auth('tok_a', 'account', { status: 'unresolved', reason: 'project_not_found' }), 'get_memory'),
    ).toBeNull();
  });
});

describe('McpRateLimitGuard', () => {
  it('token konta: wyczerpanie search_memory w X nie throttluje tego samego tokena w Y', () => {
    const guard = new McpRateLimitGuard(new RateLimiterService(config({ RATE_LIMIT_SEARCH_PER_MIN: 1 })));
    const inX = ctxFor(auth('tok_acc', 'account', resolved('proj_x')), call('search_memory'));
    const inY = ctxFor(auth('tok_acc', 'account', resolved('proj_y')), call('search_memory'));

    expect(guard.canActivate(inX)).toBe(true);
    expect(() => guard.canActivate(inX)).toThrow(RateLimitedException);
    // Ten sam token, inny projekt → własny, nietknięty budżet.
    expect(guard.canActivate(inY)).toBe(true);
    expect(() => guard.canActivate(inY)).toThrow(RateLimitedException);
  });

  it('token projektowy: zachowanie per-token bez zmian (stały projekt)', () => {
    const guard = new McpRateLimitGuard(new RateLimiterService(config({ RATE_LIMIT_SEARCH_PER_MIN: 1 })));
    const own = ctxFor(auth('tok_p1', 'project', resolved('proj_x')), call('search_memory'));
    const other = ctxFor(auth('tok_p2', 'project', resolved('proj_x')), call('search_memory'));

    expect(guard.canActivate(own)).toBe(true);
    expect(() => guard.canActivate(own)).toThrow(RateLimitedException);
    expect(guard.canActivate(other)).toBe(true); // inny token tego samego projektu — własny budżet
  });

  it('nierozwiązany projekt przepuszcza zawsze i nie zużywa żadnego bucketu', () => {
    const limiter = new RateLimiterService(config({ RATE_LIMIT_SEARCH_PER_MIN: 1 }));
    const guard = new McpRateLimitGuard(limiter);
    const unresolved = ctxFor(
      auth('tok_acc', 'account', { status: 'unresolved', reason: 'project_required' }),
      call('search_memory'),
    );
    for (let i = 0; i < 5; i++) expect(guard.canActivate(unresolved)).toBe(true);

    // Bucket nie powstał: pierwsze wywołanie z rozwiązanym projektem dostaje pełny budżet (limit 1).
    const inX = ctxFor(auth('tok_acc', 'account', resolved('proj_x')), call('search_memory'));
    expect(guard.canActivate(inX)).toBe(true);
    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(1);
  });

  it('create_project używa klucza tokenId:account i własnego limitu', () => {
    const limiter = new RateLimiterService(
      config({ RATE_LIMIT_CREATE_PROJECT_PER_MIN: 2, RATE_LIMIT_SAVE_PER_MIN: 1000 }),
    );
    const guard = new McpRateLimitGuard(limiter);
    const create = ctxFor(
      auth('tok_acc', 'account', { status: 'unresolved', reason: 'project_required' }),
      call('create_project'),
    );
    expect(guard.canActivate(create)).toBe(true);
    expect(guard.canActivate(create)).toBe(true);
    expect(() => guard.canActivate(create)).toThrow(RateLimitedException);
    expect([...(limiter as unknown as { buckets: Map<string, unknown> }).buckets.keys()]).toEqual([
      'tok_acc:account:create_project',
    ]);
  });

  it('tools/list i inne metody JSON-RPC nie są limitowane', () => {
    const guard = new McpRateLimitGuard(new RateLimiterService(config({}, 1)));
    const list = ctxFor(auth('tok_acc', 'account', resolved('proj_x')), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (let i = 0; i < 5; i++) expect(guard.canActivate(list)).toBe(true);
  });

  it('nieznane narzędzie nie jest limitowane; brak mcpAuth przepuszcza defensywnie', () => {
    const guard = new McpRateLimitGuard(new RateLimiterService(config({}, 1)));
    const unknown = ctxFor(auth('tok_acc', 'account', resolved('proj_x')), call('whatever'));
    for (let i = 0; i < 3; i++) expect(guard.canActivate(unknown)).toBe(true);
    expect(guard.canActivate(ctxFor(undefined, call('search_memory')))).toBe(true);
  });
});
