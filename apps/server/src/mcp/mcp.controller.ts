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
import type { Request, Response } from 'express';
import { MemoryService } from '../memory/memory.service';
import { BearerGuard } from '../projects/bearer.guard';
import type { ProjectContext } from '../projects/projects.service';
import { RateLimitExceptionFilter } from '../rate-limit/rate-limit.filter';
import { McpIpThrottleGuard } from './mcp-ip-throttle.guard';
import { McpRateLimitGuard } from './mcp-rate-limit.guard';
import { createMcpServer } from './mcp-server.factory';

type RequestWithContext = Request & { projectContext?: ProjectContext };

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
 * `projectContext` z `BearerGuard` (ustawiony na `req.projectContext`) domykany w closure przy
 * budowie serwera per-request (`createMcpServer`) — najprostsza opcja spójna z resztą stacku
 * (bez AsyncLocalStorage, którego by tu nie było komu odczytać poza tym jednym miejscu).
 */
@Controller('mcp')
// Kolejność istotna: throttle pre-auth per IP (C1) PRZED BearerGuard (który dotyka DB), potem
// rate-limit post-auth per token × narzędzie. Guard, który rzuci, zatrzymuje łańcuch.
@UseGuards(McpIpThrottleGuard, BearerGuard, McpRateLimitGuard)
@UseFilters(RateLimitExceptionFilter)
export class McpController {
  constructor(private readonly memory: MemoryService) {}

  @Post()
  async handlePost(@Req() req: RequestWithContext, @Res() res: Response): Promise<void> {
    const ctx = req.projectContext;
    if (!ctx) {
      // BearerGuard już by rzucił 401 wcześniej — czysto defensywne.
      res.status(HttpStatus.UNAUTHORIZED).json({ error: 'unauthorized' });
      return;
    }

    const server = createMcpServer(this.memory, ctx);
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
