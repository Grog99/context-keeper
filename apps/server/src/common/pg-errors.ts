/** Kształt błędu `pg` (`DatabaseError`) + `cause` — to, czego szukamy w łańcuchu przyczyn. */
export interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/** Ile poziomów `cause` sprawdzamy (drizzle owija błąd drivera raz; zapas na kolejne owinięcia). */
export const MAX_CAUSE_DEPTH = 4;

/** Postgres `unique_violation` (23505) — fallback dla race na partial unique index
 * `project_tokens_project_label_active_key` gdy dwa równoległe requesty przechodzą pre-check
 * jednocześnie (§createToken/rotateToken/updateTokenLabel). `constraint` (opcjonalnie) zawęża do
 * konkretnego indeksu — np. `projects_slug_key` przy wyścigu o slug.
 *
 * drizzle-orm 0.45 rethrowuje KAŻDY błąd drivera jako `DrizzleQueryError` (tylko `query`/`params`/
 * `cause`, bez `code`/`constraint`), więc oryginalny błąd `pg` siedzi w `err.cause` — stąd przejście
 * po łańcuchu `cause` zamiast czytania `err.code` wprost. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    const pgErr = current as PgErrorLike;
    if (pgErr.code === '23505' && (constraint === undefined || pgErr.constraint === constraint)) {
      return true;
    }
    current = pgErr.cause;
  }
  return false;
}
