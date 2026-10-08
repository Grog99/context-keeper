import type { AutoHoldReason, ProposalType } from '../types/domain';

/**
 * Co recenzent może zrobić z propozycją danego typu — `Record<ProposalType, …>` wymusza (typecheck)
 * decyzję przy każdym nowym typie. `create_project` (roadmap v1.5) nie ma treści pamięci: ani edycji
 * (serwer: `ProposalsService.edit` → `validation_error`), ani supersession (`approve({supersedes})`
 * tylko dla `create`). Pozostałe typy zachowują dotychczasowe zachowanie przycisków.
 */
export const PROPOSAL_CAPABILITIES: Record<ProposalType, { edit: boolean; supersede: boolean }> = {
  create: { edit: true, supersede: true },
  update: { edit: true, supersede: true },
  merge: { edit: true, supersede: true },
  delete: { edit: true, supersede: true },
  create_project: { edit: false, supersede: false },
};

/**
 * Powody zawrócenia z auto mode (roadmap v1.6, A2, G5 + D2) — etykiety dla recenzenta. `Record` wymusza
 * (typecheck) etykietę przy każdym nowym powodzie. Agent tych powodów NIGDY nie widzi (tylko `pending`).
 */
/** Krótkie etykiety powodów zawrócenia (A4) — komórki tabeli auto mode na „Pomiarach". */
export const AUTO_HOLD_REASON_SHORT_LABEL: Record<AutoHoldReason, string> = {
  near_duplicate: 'prawie-duplikat',
  not_computed: 'nie sprawdzono',
  human_target: 'treść człowieka',
  daily_limit: 'limit dzienny',
  auto_failed: 'błąd auto-akceptacji',
};

/**
 * Zamienia liczności rozłącznych kubełków na CAŁKOWITE procenty sumujące się dokładnie do 100 (metoda największej
 * reszty) — zwykłe `Math.round` per kubełek potrafi dać 99% albo 101%. Pusta kohorta (suma 0) → same zera.
 */
export function percentShares(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c / total) * 100);
  const floors = exact.map(Math.floor);
  let missing = 100 - floors.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((v, i) => ({ i, rem: v - floors[i] }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of byRemainder) {
    if (missing <= 0) break;
    floors[i] += 1;
    missing -= 1;
  }
  return floors;
}

export const AUTO_HOLD_REASON_LABEL: Record<AutoHoldReason, string> = {
  near_duplicate: 'prawie-duplikat istniejącej pamięci',
  not_computed: 'nie udało się sprawdzić podobieństwa (embedding niedostępny lub przekroczony budżet czasu)',
  human_target: 'korekta treści napisanej lub poprawionej przez człowieka',
  daily_limit: 'wyczerpany dzienny limit auto-akceptacji projektu',
  auto_failed: 'auto-akceptacja nie powiodła się (błąd po stronie serwera) — zdecyduj ręcznie',
};
