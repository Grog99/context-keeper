import { ToolError } from '../common/errors';
import type { ProjectTokenState } from '../db/schema';

/**
 * Reguła "czy token jest usable" (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") —
 * pure, DB-free, jednostkowo testowalna. MUSI dawać dokładnie ten sam wynik co SQL-owy
 * `usableTokenCondition()` w `projects.service.ts` (`status='active' OR (status='grace' AND
 * expires_at > now())`) — jeden authoritative predykat auth (SQL), drugi do wyświetlania w
 * dashboardzie/CLI (TS). Rozjazd między nimi = bug klasy "UI mówi jedno, auth robi drugie".
 *
 * `expired` NIE jest persystowanym stanem (§enums.ts `projectTokenState`) — pochodna `grace` +
 * `expires_at <= now()`, liczona TU, lazily, przy każdym renderze/lookupie. Brak nocnego sweepu:
 * gdyby `expired` był normalizowany asynchronicznie, DB mogłaby mówić `grace` (jeszcze niezamieciony)
 * podczas gdy semantyka już mówi "wygasł" — dwa źródła prawdy. Zamiast tego oba miejsca (SQL auth,
 * TS display) liczą DOKŁADNIE TĘ SAMĄ granicę czasową z jednego zegara — auth czyta zegar bazy
 * (`now()` w SQL), `effectiveTokenStatus` dostaje `now` jako parametr (zegar wołającego — w
 * kontrolerze/CLI to zegar procesu Node, wystarczająco blisko zegara DB dla wyświetlania; auth nigdy
 * nie woła tej funkcji, więc rozjazd rzędu milisekund między zegarami nie ma żadnego bezpieczeństwo-
 * krytycznego skutku, tylko kosmetyczny przy granicy).
 */
export type EffectiveTokenStatus = 'active' | 'grace' | 'expired' | 'revoked';

export function effectiveTokenStatus(
  row: { status: ProjectTokenState; expiresAt: Date | null },
  now: Date,
): EffectiveTokenStatus {
  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'active') return 'active';
  // status === 'grace': usable dopóki expiresAt w przyszłości; brak expiresAt (nie powinno się
  // zdarzyć dla grace — zawsze ustawiany przy rotateToken) traktujemy konserwatywnie jako wygasły,
  // nigdy jako wiecznie ważny.
  if (row.expiresAt && row.expiresAt.getTime() > now.getTime()) return 'grace';
  return 'expired';
}

/** Limit etykiety tokena (atrybucja per-agent, WYMAGANA przy tworzeniu — locked decision planu §0
 * pkt 3). 40 znaków — symetryczne z `TAG_MAX_LEN` (`config/env.ts`), etykieta jest krótkim
 * identyfikatorem, nie opisem. */
export const TOKEN_LABEL_MAX_LEN = 40;

const TOKEN_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/**
 * Normalizacja + walidacja etykiety tokena — dzielona logika dla `createToken`/`rotateToken`/
 * `updateTokenLabel` (§projects.service.ts) oraz klienckiego mirrora w `ProjectTokensDialog.tsx`
 * (walidacja natychmiastowa w UI, serwer zostaje authoritative). Trim, potem: 1..40 znaków,
 * `[A-Za-z0-9 ._-]`, musi zaczynać się alfanumerycznie (żeby uniknąć etykiet zaczynających się
 * spacją/kropką — czytelność w tabeli/CLI). Puste po trimie -> `validation_error`.
 */
export function normalizeTokenLabel(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    throw new ToolError('validation_error', 'label jest wymagany (atrybucja per-agent).');
  }
  if (trimmed.length > TOKEN_LABEL_MAX_LEN) {
    throw new ToolError(
      'validation_error',
      `label zbyt długi (max ${TOKEN_LABEL_MAX_LEN} znaków, jest ${trimmed.length}).`,
    );
  }
  if (!TOKEN_LABEL_RE.test(trimmed)) {
    throw new ToolError(
      'validation_error',
      'label może zawierać wyłącznie litery/cyfry/spacje/`.`/`_`/`-` i musi zaczynać się znakiem alfanumerycznym.',
    );
  }
  return trimmed;
}
