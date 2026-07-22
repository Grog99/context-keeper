import { ApiError } from './api';

/** Komunikaty błędów API po polsku (§11 design-systemu: "co poszło nie tak + jak naprawić, bez
 * przeprosin") — mapuje kody z `DashboardErrorFilter` (`ProposalError`/`ToolError`) na copy. */
export function describeApiError(err: unknown, fallback = 'Coś poszło nie tak. Spróbuj ponownie.'): string {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.code === 'stale') {
      return 'Baza zmieniła się w międzyczasie (stale) — odśwież listę i spróbuj ponownie.';
    }
    if (err.status === 409 && err.code === 'already_decided') {
      return 'Ta propozycja została już rozpatrzona (przez kogoś innego albo w innej karcie).';
    }
    if (err.status === 401) {
      return 'Sesja wygasła — zaloguj się ponownie.';
    }
    if (err.status === 429) {
      return 'Zbyt wiele prób — spróbuj ponownie za chwilę.';
    }
    return err.message || fallback;
  }
  return fallback;
}
