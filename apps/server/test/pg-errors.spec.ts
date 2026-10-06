import { describe, expect, it } from 'vitest';
import { isUniqueViolation, MAX_CAUSE_DEPTH } from '../src/common/pg-errors';

/** Błąd w kształcie `DatabaseError` z `pg` (code + constraint na wierzchu). */
function pgError(constraint: string, code = '23505') {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code, constraint });
}

/** drizzle 0.45 owija błąd drivera w `DrizzleQueryError` — bez `code`/`constraint`, z `cause`. */
function wrap(cause: unknown): Error {
  return Object.assign(new Error('Failed query'), { cause });
}

describe('isUniqueViolation', () => {
  it('rozpoznaje 23505 podany wprost (code na wierzchu)', () => {
    expect(isUniqueViolation(pgError('projects_slug_key'))).toBe(true);
  });

  it('rozpoznaje 23505 owinięty w cause (kształt DrizzleQueryError)', () => {
    expect(isUniqueViolation(wrap(pgError('projects_slug_key')))).toBe(true);
  });

  it('constraint zawęża dopasowanie: ten sam constraint -> true, inny -> false', () => {
    const err = wrap(pgError('project_tokens_token_hash_key'));
    expect(isUniqueViolation(err, 'project_tokens_token_hash_key')).toBe(true);
    // Kolizja hasha tokena NIE jest kolizją etykiety — ma propagować, nie mapować się na validation_error.
    expect(isUniqueViolation(err, 'project_tokens_project_label_active_key')).toBe(false);
    expect(isUniqueViolation(err, 'project_tokens_account_label_active_key')).toBe(false);
  });

  it('inny kod SQLSTATE (np. 23503 foreign_key_violation) -> false, także z pasującym constraintem', () => {
    expect(isUniqueViolation(pgError('projects_slug_key', '23503'))).toBe(false);
    expect(isUniqueViolation(pgError('projects_slug_key', '23503'), 'projects_slug_key')).toBe(false);
  });

  it('przeszukuje łańcuch cause do MAX_CAUSE_DEPTH poziomów, głębiej nie', () => {
    let within: unknown = pgError('projects_slug_key');
    for (let i = 0; i < MAX_CAUSE_DEPTH; i++) within = wrap(within);
    expect(isUniqueViolation(within)).toBe(true);

    expect(isUniqueViolation(wrap(within))).toBe(false);
  });

  it('wartości nie-obiektowe i błędy bez code -> false', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(23505)).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(wrap(null))).toBe(false);
  });

  it('cykliczny cause nie zapętla się (limit głębokości)', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(isUniqueViolation(a)).toBe(false);
  });
});
