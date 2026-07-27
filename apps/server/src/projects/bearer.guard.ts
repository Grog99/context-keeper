import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { extractBearer } from '../common/tokens';
import { ProjectContext, ProjectsService } from './projects.service';

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  projectContext?: ProjectContext;
}

/**
 * Auth powierzchni MCP (§10): statyczny bearer per token (roadmap v1.3, "Wiele tokenów per projekt
 * + graceful rotation" — N tokenów per projekt, każdy z własnym cyklem życia).
 * Zły/brak/nieusable (nieznany, wygasły, unieważniony) token → 401 z IDENTYCZNYM komunikatem
 * (§Risks planu "Token-existence oracle" — anty-probing, rozróżnienie tylko w logu serwera).
 * Wpinane do controllera `/mcp` w Fazie 2. Kontekst projektu + tokena dołączany do requestu
 * (`req.projectContext`) dla downstreamu (atrybucja per-agent, rate limiting per-token).
 */
@Injectable()
export class BearerGuard implements CanActivate {
  private readonly logger = new Logger(BearerGuard.name);

  constructor(private readonly projects: ProjectsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestLike>();
    const header = req.headers['authorization'];
    const token = extractBearer(Array.isArray(header) ? header[0] : header);
    if (!token) {
      throw new UnauthorizedException('Brak nagłówka Authorization: Bearer');
    }
    const resolved = await this.projects.resolveByToken(token);
    if (!resolved) {
      // Log server-side ONLY (nigdy raw token/hash) — odróżnienie nieznany/wygasły/unieważniony
      // zostaje dla operatora, ale klient zawsze widzi ten sam 401 (anty-probing).
      this.logger.warn('Odrzucony bearer: nieznany, wygasły albo unieważniony token.');
      throw new UnauthorizedException('Nieprawidłowy token');
    }
    req.projectContext = {
      projectId: resolved.project.id,
      projectName: resolved.project.name,
      includeEventsInDefaultSearch: resolved.project.includeEventsInDefaultSearch,
      tokenId: resolved.token.id,
      tokenLabel: resolved.token.label,
    };
    // Best-effort, fire-and-forget (§D3 planu) — NIGDY awaited na ścieżce auth.
    this.projects.touchTokenUsage(resolved.token.id);
    return true;
  }
}
