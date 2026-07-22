import { createHash, randomBytes } from 'node:crypto';

/**
 * Bearer token projektu (§10):
 *  - format: `ck_` + 256-bit losowości (base64url, ~43 znaki),
 *  - w bazie trzymamy WYŁĄCZNIE SHA-256 (deterministyczny, indeksowany, bez pepper),
 *  - pełny token pokazywany operatorowi tylko raz.
 */
export const TOKEN_PREFIX = 'ck_';

// base64url z 32 bajtów = 43 znaki (bez paddingu).
const TOKEN_RANDOM_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** SHA-256 (hex) — kolumna `token_hash`. Bez slow-hash: token ma pełną entropię, lookup musi być indeksowany. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Tania walidacja formatu przed lookupem (nie bezpieczeństwo — tylko odrzucenie oczywistych śmieci). */
export function isValidTokenFormat(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX) && TOKEN_RANDOM_RE.test(token.slice(TOKEN_PREFIX.length));
}

/** Wyciąga bearer z nagłówka Authorization. Zwraca null przy braku/złym schemacie. */
export function extractBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, value] = authorization.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
}
