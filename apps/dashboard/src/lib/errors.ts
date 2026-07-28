import { ApiError } from './api';
import type { BulkDecisionItemError, BulkFailureCode } from '../types/api';

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
    if (err.status === 409 && err.code === 'already_purged') {
      return 'Ta pamięć jest już wymazana (purge_tombstone).';
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

/** Etykiety grup w podsumowaniu bulku (roadmap v1.3, "Bulk approve/reject w kolejce") — po polsku,
 * spójne z `describeApiError` powyżej. */
const BULK_FAILURE_LABEL: Record<BulkFailureCode, string> = {
  stale: 'nieaktualne (stale)',
  already_decided: 'już rozpatrzone',
  not_found: 'nie istnieją',
  validation_error: 'odrzucone walidacją',
  unknown: 'błąd serwera',
};

/** Grupuje porażki `bulk-approve`/`bulk-reject` wg kodu — np. "3 nieaktualne (stale), 1 już
 * rozpatrzone" — zwięzłe podsumowanie do `description` toasta (§QueueScreen `reportBulk`). Kolejność
 * grup = kolejność pierwszego wystąpienia kodu w `failed` (ten sam porządek co odpowiedź serwera). */
export function describeBulkFailures(failed: BulkDecisionItemError[]): string {
  const counts = new Map<BulkFailureCode, number>();
  for (const item of failed) {
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([code, count]) => `${count} ${BULK_FAILURE_LABEL[code]}`)
    .join(', ');
}
