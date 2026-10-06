import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { McpAuthContext, RequestWithMcpAuth } from '../projects/project-scope';
import { RateLimitedException } from '../rate-limit/rate-limited.exception';
import {
  ACCOUNT_TOOLS,
  MEMORY_TOOLS,
  RateLimiterService,
  type RateLimitedTool,
} from '../rate-limit/rate-limiter.service';

const KNOWN_TOOLS: ReadonlySet<string> = new Set<string>([...MEMORY_TOOLS, ...ACCOUNT_TOOLS]);
const ACCOUNT_TOOL_SET: ReadonlySet<string> = new Set<string>(ACCOUNT_TOOLS);

interface JsonRpcToolCallBody {
  method?: string;
  params?: { name?: string };
}

/**
 * Klucz bucketu rate limitu (roadmap v1.5, ticket #17) — czysta funkcja, testowalna bez Nesta:
 *  - narzędzie konta (`list_projects`/`create_project`) → `${tokenId}:account`;
 *  - narzędzie pamięci z rozwiązanym projektem → `${tokenId}:${projectId}` (token konta ma osobny
 *    budżet w każdym projekcie; token projektowy ma stały projekt, więc bez zmian);
 *  - narzędzie pamięci z NIEROZWIĄZANYM projektem → `null`: wywołanie i tak skończy się błędem
 *    tool-level bez żadnych skutków ubocznych, więc nie zużywa budżetu (backstop to throttle per IP).
 */
export function rateLimitKey(auth: McpAuthContext, tool: string): string | null {
  if (ACCOUNT_TOOL_SET.has(tool)) return `${auth.tokenId}:account`;
  if (auth.project.status !== 'resolved') return null;
  return `${auth.tokenId}:${auth.project.context.projectId}`;
}

/**
 * Rate limiting per token × (projekt) × narzędzie (§10 tech-stack, NFR-3). Musi biec PO `BearerGuard`
 * (potrzebuje `mcpAuth`). Limituje wyłącznie `tools/call` na jedno ze znanych narzędzi (pamięci i
 * konta) — `initialize`/`tools/list` i inne metody JSON-RPC nie są limitowane w v1.
 *
 * Klucz składa `rateLimitKey` — nadal zawsze zawiera `tokenId` (roadmap v1.3: każdy token ma własny
 * budżet, nie dzielony między agentów tego samego projektu), od v1.5 dodatkowo `projectId`/`account`.
 */
@Injectable()
export class McpRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RequestWithMcpAuth>();
    const body = req.body as JsonRpcToolCallBody | undefined;
    const toolName = body?.method === 'tools/call' ? body.params?.name : undefined;
    if (!toolName || !KNOWN_TOOLS.has(toolName)) {
      return true; // nie tools/call na znane narzędzie — bez limitu w v1
    }

    if (!req.mcpAuth) {
      return true; // BearerGuard już by odrzucił brak auth — defensywnie przepuszczamy
    }
    const key = rateLimitKey(req.mcpAuth, toolName);
    if (!key) {
      return true; // projekt nierozwiązany — narzędzie zwróci błąd, bez zużycia budżetu
    }

    const result = this.limiter.tryConsume(key, toolName as RateLimitedTool);
    if (!result.allowed) {
      throw new RateLimitedException(result.retryAfterSec);
    }
    return true;
  }
}
