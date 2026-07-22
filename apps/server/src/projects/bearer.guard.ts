import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { extractBearer } from '../common/tokens';
import { ProjectContext, ProjectsService } from './projects.service';

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  projectContext?: ProjectContext;
}

/**
 * Auth powierzchni MCP (§10): statyczny bearer per projekt.
 * Zły/brak tokena → 401 (błąd transportu, nie tool-level). Wpinane do controllera `/mcp` w Fazie 2.
 * Kontekst projektu dołączany do requestu (`req.projectContext`) dla downstreamu.
 */
@Injectable()
export class BearerGuard implements CanActivate {
  constructor(private readonly projects: ProjectsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestLike>();
    const header = req.headers['authorization'];
    const token = extractBearer(Array.isArray(header) ? header[0] : header);
    if (!token) {
      throw new UnauthorizedException('Brak nagłówka Authorization: Bearer');
    }
    const project = await this.projects.resolveProjectByToken(token);
    if (!project) {
      throw new UnauthorizedException('Nieprawidłowy token');
    }
    req.projectContext = { projectId: project.id, projectName: project.name };
    return true;
  }
}
