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
export const AUTO_HOLD_REASON_LABEL: Record<AutoHoldReason, string> = {
  near_duplicate: 'prawie-duplikat istniejącej pamięci',
  not_computed: 'nie udało się sprawdzić podobieństwa (embedding niedostępny lub przekroczony budżet czasu)',
  human_target: 'korekta treści napisanej lub poprawionej przez człowieka',
  daily_limit: 'wyczerpany dzienny limit auto-akceptacji projektu',
  auto_failed: 'auto-akceptacja nie powiodła się (błąd po stronie serwera) — zdecyduj ręcznie',
};
