import {
  Controller,
  Delete,
  Get,
  HttpStatus,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Response } from 'express';
import { MemoryService } from '../memory/memory.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { ProjectProposalService } from '../onboarding/project-proposal.service';
import { BearerGuard } from '../projects/bearer.guard';
import type { RequestWithMcpAuth } from '../projects/project-scope';
import { ProjectSlugService } from '../projects/project-slug.service';
import { RateLimitExceptionFilter } from '../rate-limit/rate-limit.filter';
import { McpIpThrottleGuard } from './mcp-ip-throttle.guard';
import { McpRateLimitGuard } from './mcp-rate-limit.guard';
import { createMcpServer } from './mcp-server.factory';

const METHOD_NOT_ALLOWED_BODY = {
  jsonrpc: '2.0' as const,
  error: { code: -32000, message: 'Method not allowed.' },
  id: null,
};

/**
 * Transport MCP: Streamable HTTP, tryb BEZSTANOWY (§5 tech-stack — decyzja architektoniczna 1).
 * Nowy `McpServer` + `StreamableHTTPServerTransport` (sessionIdGenerator: undefined) TWORZONE
 * PER REQUEST i zamykane po odpowiedzi. Bez mapy sesji, bez nagłówka `Mcp-Session-Id`.
 *
 * Kontekst auth z `BearerGuard` (`req.mcpAuth`: token + rozwiązanie projektu, roadmap v1.5)
 * domykany w closure przy budowie serwera per-request (`createMcpServer`) — najprostsza opcja
 * spójna z resztą stacku (bez AsyncLocalStorage, którego by tu nie było komu odczytać poza tym
 * jednym miejscem).
 */
@Controller('mcp')
// Kolejność istotna: throttle pre-auth per IP (C1) PRZED BearerGuard (który dotyka DB), potem
// rate-limit post-auth per token × narzędzie. Guard, który rzuci, zatrzymuje łańcuch.
@UseGuards(McpIpThrottleGuard, BearerGuard, McpRateLimitGuard)
@UseFilters(RateLimitExceptionFilter)
export class McpController {
  constructor(
    private readonly memory: MemoryService,
    private readonly slugs: ProjectSlugService,
    private readonly onboarding: OnboardingService,
    private readonly projectProposals: ProjectProposalService,
  ) {}

  @Post()
  async handlePost(@Req() req: RequestWithMcpAuth, @Res() res: Response): Promise<void> {
    const auth = req.mcpAuth;
    if (!auth) {
      // BearerGuard już by rzucił 401 wcześniej — czysto defensywne.
      res.status(HttpStatus.UNAUTHORIZED).json({ error: 'unauthorized' });
      return;
    }

    const server = createMcpServer(
      {
        memory: this.memory,
        scope: this.slugs,
        onboarding: this.onboarding,
        projectProposals: this.projectProposals,
      },
      auth,
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  // Tryb bezstanowy: brak sesji do wznowienia (GET/SSE) ani zamknięcia (DELETE) — 405, jak w
  // oficjalnym przykładzie SDK (examples/server/simpleStatelessStreamableHttp).
  @Get()
  handleGet(@Res() res: Response): void {
    res.status(405).json(METHOD_NOT_ALLOWED_BODY);
  }

  @Delete()
  handleDelete(@Res() res: Response): void {
    res.status(405).json(METHOD_NOT_ALLOWED_BODY);
  }
}
