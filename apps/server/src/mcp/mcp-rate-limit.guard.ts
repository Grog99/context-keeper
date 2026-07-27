import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { ProjectContext } from '../projects/projects.service';
import { RateLimitedException } from '../rate-limit/rate-limited.exception';
import { RateLimiterService, type RateLimitedTool } from '../rate-limit/rate-limiter.service';

const KNOWN_TOOLS: ReadonlySet<string> = new Set<RateLimitedTool>([
  'search_memory',
  'get_memory',
  'save_memory',
]);

interface JsonRpcToolCallBody {
  method?: string;
  params?: { name?: string };
}

type RequestWithContext = Request & { projectContext?: ProjectContext };

/**
 * Rate limiting per token × narzędzie (§10 tech-stack, NFR-3). Musi biec PO `BearerGuard`
 * (potrzebuje `projectContext`). Limituje wyłącznie `tools/call` na jedno z 3 znanych narzędzi —
 * `initialize`/`tools/list` i inne metody JSON-RPC nie są limitowane w v1.
 *
 * Klucz = `tokenId` (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") — każdy token ma
 * własny budżet, nie dzielony między agentów tego samego projektu (§RateLimiterService). Fallback do
 * `projectId` jest defensywny (nigdy nie powinien się uruchomić na żywej ścieżce — `BearerGuard`
 * zawsze wypełnia `tokenId` po udanym auth — ale trzyma limiter działający zamiast rzucać, gdyby
 * kiedyś powstał kontekst bez tokena).
 */
@Injectable()
export class McpRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    const body = req.body as JsonRpcToolCallBody | undefined;
    const toolName = body?.method === 'tools/call' ? body.params?.name : undefined;
    if (!toolName || !KNOWN_TOOLS.has(toolName)) {
      return true; // nie tools/call na znane narzędzie — bez limitu w v1
    }

    const key = req.projectContext?.tokenId ?? req.projectContext?.projectId;
    if (!key) {
      return true; // BearerGuard już by odrzucił brak auth — defensywnie przepuszczamy
    }

    const result = this.limiter.tryConsume(key, toolName as RateLimitedTool);
    if (!result.allowed) {
      throw new RateLimitedException(result.retryAfterSec);
    }
    return true;
  }
}
