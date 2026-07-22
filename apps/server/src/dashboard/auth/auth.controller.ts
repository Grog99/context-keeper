import { Controller, Get, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { AppConfigService } from '../../config/config.service';
import { CSRF_COOKIE_NAME } from './csrf.guard';
import { LoginThrottleService } from './login-throttle.service';
import {
  createSessionPayload,
  generateCsrfToken,
  signSession,
  timingSafeEqualPassword,
  verifySession,
} from './session';
import { SessionGuard } from './session.guard';

interface SessionResponse {
  authenticated: boolean;
}

/**
 * Auth powierzchni dashboardu (§10 tech-stack, plan Fazy 5 M0). `login`/`session` CELOWO bez
 * `SessionGuard` — to punkty wejścia, po których SPA dopiero decyduje login-vs-app (§M2 `useSession`).
 * `logout` wymaga ważnej sesji, symetrycznie z resztą kontrolerów dashboardu.
 */
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly config: AppConfigService,
    private readonly throttle: LoginThrottleService,
  ) {}

  @Post('login')
  login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): SessionResponse {
    const password = typeof (req.body as { password?: unknown })?.password === 'string'
      ? (req.body as { password: string }).password
      : '';

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const throttled = this.throttle.tryConsume(ip);
    if (!throttled.allowed) {
      res.setHeader('Retry-After', String(throttled.retryAfterSec));
      res.status(HttpStatus.TOO_MANY_REQUESTS);
      return { authenticated: false };
    }

    const expected = this.config.get('DASHBOARD_PASSWORD');
    if (!expected || !timingSafeEqualPassword(password, expected)) {
      res.status(HttpStatus.UNAUTHORIZED);
      return { authenticated: false };
    }

    this.issueSession(req, res);
    res.status(HttpStatus.OK);
    return { authenticated: true };
  }

  @Post('logout')
  @UseGuards(SessionGuard)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): SessionResponse {
    res.clearCookie(this.config.get('DASHBOARD_COOKIE_NAME'), this.cookieOptions(req, true));
    res.clearCookie(CSRF_COOKIE_NAME, this.cookieOptions(req, false));
    res.status(HttpStatus.OK);
    return { authenticated: false };
  }

  @Get('session')
  session(@Req() req: Request): SessionResponse {
    const secret = this.config.get('SESSION_SECRET');
    if (!secret) return { authenticated: false };
    const cookieName = this.config.get('DASHBOARD_COOKIE_NAME');
    const raw = (req.cookies as Record<string, string> | undefined)?.[cookieName];
    return { authenticated: verifySession(raw, secret) !== null };
  }

  private issueSession(req: Request, res: Response): void {
    const secret = this.config.get('SESSION_SECRET');
    if (!secret) {
      // Nieosiągalne w praktyce — envSchema.superRefine wymaga SESSION_SECRET w produkcji, a dev
      // bez niego dostaje 401 wcześniej (SessionGuard) / nigdy nie dotrze tutaj z poprawnym hasłem
      // skoro DASHBOARD_PASSWORD i SESSION_SECRET są konfigurowane razem.
      throw new Error('SESSION_SECRET nieskonfigurowany — dashboard nie może wystawić sesji');
    }
    const payload = createSessionPayload(this.config.get('SESSION_TTL_HOURS'));
    const maxAge = (payload.exp - payload.iat) * 1000;

    res.cookie(this.config.get('DASHBOARD_COOKIE_NAME'), signSession(payload, secret), {
      ...this.cookieOptions(req, true),
      maxAge,
    });
    res.cookie(CSRF_COOKIE_NAME, generateCsrfToken(), { ...this.cookieOptions(req, false), maxAge });
  }

  /** `secure` honoruje `req.secure`, które Express sam wyprowadza z `X-Forwarded-Proto` gdy
   * `trust proxy` jest włączone (`main.ts`, sterowane `TRUST_PROXY`) — bez dodatkowej logiki tutaj. */
  private cookieOptions(req: Request, httpOnly: boolean): CookieOptions {
    return { httpOnly, sameSite: 'lax', secure: req.secure, path: '/' };
  }
}
