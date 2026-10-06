import type { ProposalType } from '../types/domain';

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
