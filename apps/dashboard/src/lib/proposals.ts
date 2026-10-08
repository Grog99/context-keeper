import type { ProposalView } from '../types/api';
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

/**
 * Wiek wpisu-targetu względem kontrpartnera w proposalu sprzeczności (roadmap v1.6, B3) — to samo
 * porządkowanie co detektor po stronie serwera (`created_at`, remis → mniejsze `id` jest „starsze"),
 * liczone na `MemoryDetail.createdAt` obu stron. `null`, gdy brakuje daty którejś strony (kontrpartner
 * niedostępny) — UI nie zgaduje wtedy kierunku wiekowego.
 */
export function conflictTargetAge(
  target: { id: string; createdAt: string | undefined },
  counterpart: { id: string; createdAt: string | undefined },
): 'older' | 'newer' | null {
  if (!target.createdAt || !counterpart.createdAt) return null;
  const t = Date.parse(target.createdAt);
  const c = Date.parse(counterpart.createdAt);
  if (Number.isNaN(t) || Number.isNaN(c)) return null;
  if (t !== c) return t < c ? 'older' : 'newer';
  return target.id < counterpart.id ? 'older' : 'newer';
}

/** Etykieta przycisku zamiany kierunku: nazywa wpis, który zostanie zarchiwizowany PO kliknięciu. */
export function swapDirectionLabel(targetAge: 'older' | 'newer' | null): string {
  if (targetAge === 'older') return 'Archiwizuj nowszy zamiast';
  if (targetAge === 'newer') return 'Archiwizuj starszy zamiast';
  return 'Zamień kierunek';
}

/** Proposal `delete` z detektora sprzeczności (B3) — niesie `counterpartId` w efektywnym payloadzie. Edycja
 * treści i zamiennik są dla niego wyłączone (serwer: `edit()` odrzuca `delete`; kierunek zmienia się osobną akcją). */
export function isConflictProposal(proposal: Pick<ProposalView, 'type' | 'payload' | 'editedPayload'>): boolean {
  return proposal.type === 'delete' && Boolean((proposal.editedPayload ?? proposal.payload).counterpartId);
}
