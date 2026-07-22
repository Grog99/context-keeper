import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sesja dashboardu (§10 tech-stack, plan Fazy 5 M0) — stateless, podpisany cookie, bez tabeli sesji.
 * Wartość cookie: `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`. Payload niesie własną
 * wygasłość (`exp`), więc weryfikacja jest samowystarczalna — `cookie-parser` w `main.ts` służy tylko
 * do parsowania `req.cookies`, nie do jego wbudowanego mechanizmu signed cookies.
 */
export interface SessionPayload {
  authenticated: true;
  iat: number; // epoch (sekundy)
  exp: number; // epoch (sekundy)
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * Weryfikuje podpis (constant-time) i wygasłość. `null` przy dowolnym problemie (brak, tampering,
 * zły format, wygasłość) — wołający (`SessionGuard`) mapuje jednolicie na 401 bez rozróżniania
 * przyczyny, jak `BearerGuard`/`MemoryService.get` gdzie indziej w bazie kodu.
 */
export function verifySession(cookieVal: string | undefined | null, secret: string): SessionPayload | null {
  if (!cookieVal) return null;
  const dotIndex = cookieVal.lastIndexOf('.');
  if (dotIndex <= 0) return null;
  const body = cookieVal.slice(0, dotIndex);
  const sig = cookieVal.slice(dotIndex + 1);

  let sigBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, 'base64url');
    expectedBuf = Buffer.from(sign(body, secret), 'base64url');
  } catch {
    return null;
  }
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload?.authenticated !== true || typeof payload.exp !== 'number') return null;
  if (Date.now() >= payload.exp * 1000) return null;
  return payload;
}

export function createSessionPayload(ttlHours: number, now: Date = new Date()): SessionPayload {
  const iat = Math.floor(now.getTime() / 1000);
  return { authenticated: true, iat, exp: iat + Math.round(ttlHours * 3600) };
}

/**
 * Constant-time porównanie hasła (§10 ryzyka planu). W przeciwieństwie do bearer tokena
 * (`resolveProjectByToken` — wysokoentropijny, lookup indeksowany po hashu) hasło dashboardu jest
 * niskoentropijne i porównywane wprost — timing attack na długość/prefiks jest tu realny.
 * Przy różnej długości i tak wykonujemy porównanie o koszcie stałym (względem `expected`), żeby sam
 * wczesny return na długości nie przeciekał informacji.
 */
export function timingSafeEqualPassword(input: string, expected: string): boolean {
  const inputBuf = Buffer.from(input, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (inputBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf); // koszt porównania stały niezależnie od gałęzi
    return false;
  }
  return timingSafeEqual(inputBuf, expectedBuf);
}

/** Token CSRF (double-submit, `csrf.guard.ts`) — wysokoentropijny, nie musi być tajny wobec JS SPA. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}
