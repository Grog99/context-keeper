import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { extractBearer } from '../common/tokens';
import { PROJECT_HEADER, readProjectHeader, tokenScopeOf, type RequestWithMcpAuth } from './project-scope';
import { ProjectsService } from './projects.service';

type RequestLike = Pick<RequestWithMcpAuth, 'headers' | 'mcpAuth'>;

/**
 * Auth powierzchni MCP (§10): statyczny bearer per token (roadmap v1.3, "Wiele tokenów per projekt
 * + graceful rotation" — N tokenów per projekt, każdy z własnym cyklem życia) albo token KONTA
 * (v1.5, `project_id IS NULL` — działa w każdym projekcie instancji).
 * Zły/brak/nieusable (nieznany, wygasły, unieważniony) token → 401 z IDENTYCZNYM komunikatem
 * (§Risks planu "Token-existence oracle" — anty-probing, rozróżnienie tylko w logu serwera) —
 * także dla tokenu konta. Wpinane do controllera `/mcp` w Fazie 2.
 *
 * Rozwiązanie PROJEKTU (nagłówek `X-Context-Keeper-Project`) NIGDY nie odrzuca żądania: każdy ważny
 * token przechodzi, a guard dołącza do requestu `req.mcpAuth` (token + `ProjectResolution`:
 * rozwiązany `ProjectContext` albo powód nierozwiązania). Narzędzia pamięci zamieniają stan
 * "nierozwiązany" na błąd tool-level (`isError` + `{code, message, details?}`) — przy HTTP 4xx klient
 * MCP uznałby serwer za niepodłączony i agent nie dostałby wskazówki (ticket #12).
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
    const lookup = await this.projects.lookupToken(token);
    if (!lookup) {
      // Log server-side ONLY (nigdy raw token/hash) — odróżnienie nieznany/wygasły/unieważniony
      // zostaje dla operatora, ale klient zawsze widzi ten sam 401 (anty-probing).
      this.logger.warn('Odrzucony bearer: nieznany, wygasły albo unieważniony token.');
      throw new UnauthorizedException('Nieprawidłowy token');
    }
    req.mcpAuth = {
      tokenId: lookup.token.id,
      tokenLabel: lookup.token.label,
      // Scope rozstrzyga `projectId` tokena, nie "brak wiersza projektu" (FK cascade).
      tokenScope: tokenScopeOf(lookup.token.projectId),
      project: await this.projects.resolveProjectScope(lookup, readProjectHeader(req.headers[PROJECT_HEADER])),
    };
    // Best-effort, fire-and-forget (§D3 planu) — NIGDY awaited na ścieżce auth. Oba typy tokenów.
    this.projects.touchTokenUsage(lookup.token.id);
    return true;
  }
}
