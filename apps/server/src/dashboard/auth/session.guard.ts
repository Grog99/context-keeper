import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../../config/config.service';
import { verifySession } from './session';

export interface DashboardSession {
  authenticated: true;
}

export type RequestWithDashboardSession = Request & { dashboardSession?: DashboardSession };

/**
 * Auth powierzchni dashboardu (§10 tech-stack, plan Fazy 5 M0) — odpowiednik `BearerGuard` dla
 * `/mcp`, ale kontroler-scoped (nigdy global — patrz Ryzyka planu: `/mcp` nie może dostać żadnego
 * nowego globalnego guarda). Zły/brak/wygasły cookie → 401, bez rozróżniania przyczyny.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RequestWithDashboardSession>();
    const secret = this.config.get('SESSION_SECRET');
    if (!secret) {
      throw new UnauthorizedException('Sesja dashboardu nieskonfigurowana (brak SESSION_SECRET)');
    }
    const cookieName = this.config.get('DASHBOARD_COOKIE_NAME');
    const raw = (req.cookies as Record<string, string> | undefined)?.[cookieName];
    const payload = verifySession(raw, secret);
    if (!payload) {
      throw new UnauthorizedException('Brak lub nieważna sesja — zaloguj się ponownie');
    }
    req.dashboardSession = { authenticated: true };
    return true;
  }
}
