/** Typy domenowe SPA — lustro kontraktu `apps/server` (enumy `db/schema/enums.ts` + kody błędów),
 * NIE import cross-package (§Approach planu: toolchainy Vite/ESM i Nest/CommonJS celowo rozdzielone). */

export type MemoryKind = 'fact' | 'document' | 'event';
export type MemoryScope = 'global' | 'project';
export type MemoryStatus = 'approved' | 'archived' | 'purged';
export type MemorySource = 'agent' | 'human' | 'nightly';

export type ProposalType = 'create' | 'update' | 'merge' | 'delete';
export type ProposalOrigin = 'agent' | 'human' | 'nightly';
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

/** Lustro `ProposalErrorCode` (`apps/server/src/proposals/proposals.errors.ts`) — kody błędów
 * domenowych kolejki, m.in. per-item w `BulkDecisionResult.failed` (roadmap v1.3, "Bulk
 * approve/reject w kolejce"). */
export type ProposalErrorCode = 'not_found' | 'already_decided' | 'stale' | 'validation_error';

export type RevisionAction = 'created' | 'edited' | 'promote' | 'archive' | 'superseded_by';

/** Słownik typów relacji (roadmap v1.2, "memory-relations + 1-hop graph boost") — dokładnie 3
 * wartości, lustro `relation_type` (`apps/server/src/db/schema/enums.ts`). */
export type RelationType = 'caused_by' | 'follows' | 'context_for';

export type AuditEventType =
  | 'proposal_created'
  | 'proposal_approved'
  | 'proposal_rejected'
  | 'proposal_edited'
  | 'human_edit'
  | 'archive'
  | 'promote'
  | 'token_created'
  | 'token_rotated'
  | 'token_revoked'
  | 'token_relabeled'
  | 'secret_blocked'
  | 'purge_tombstone'
  | 'nightly_run'
  | 'backup_completed'
  | 'project_settings_changed'
  | 'relation_created'
  | 'relation_removed';

/** Lustro `ProjectTokenState` (`apps/server/src/db/schema/enums.ts`) — stan PERSYSTOWANY na wierszu
 * `project_tokens`. `expired` NIE jest tu — to pochodna, patrz `EffectiveTokenStatus`. */
export type ProjectTokenState = 'active' | 'grace' | 'revoked';

/** Lustro `EffectiveTokenStatus` (`apps/server/src/projects/token-status.ts`) — co dashboard
 * faktycznie renderuje (`TokenStatusBadge`). `expired` liczony server-side (`ProjectTokenDto.effectiveStatus`),
 * SPA nigdy nie liczy tego sama z `status`+`expiresAt` (jedna authoritative reguła, po stronie serwera). */
export type EffectiveTokenStatus = 'active' | 'grace' | 'expired' | 'revoked';
