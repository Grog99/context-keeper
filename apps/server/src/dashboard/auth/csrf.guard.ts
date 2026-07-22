import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

export const CSRF_COOKIE_NAME = 'ck_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** `Sec-Fetch-Site` gdy obecny jest autorytatywny; gdy brak (nie wszystkie klienty/przeglądarki go
 * wysyłają), spadamy na porównanie hosta z `Origin` — brak OBU nagłówków nie jest sam w sobie błędem
 * (double-submit token poniżej to główna linia obrony), ale gdy któryś wskazuje cross-site, odrzucamy. */
function isCrossSite(req: Request): boolean {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string') {
    return secFetchSite !== 'same-origin' && secFetchSite !== 'none';
  }
  const origin = req.headers['origin'];
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true; // Origin obecny, ale niepasrsowalny — traktuj podejrzanie
  }
}

/**
 * Double-submit CSRF (§10 ryzyka planu): dla metod mutujących nagłówek `X-CSRF-Token` musi równać
 * się wartości cookie `ck_csrf` (celowo NIE-HttpOnly — SPA musi go móc odczytać i wysłać w nagłówku;
 * `ck_session` obok pozostaje HttpOnly). Dopełnione asercją same-origin.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!MUTATING_METHODS.has(req.method)) return true;

    if (isCrossSite(req)) {
      throw new ForbiddenException('Żądanie cross-site odrzucone');
    }

    const cookieVal = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE_NAME];
    const headerVal = req.headers[CSRF_HEADER_NAME];
    const header = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (!cookieVal || !header || header !== cookieVal) {
      throw new ForbiddenException('Brak lub niezgodny token CSRF');
    }
    return true;
  }
}
