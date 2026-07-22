/** Typy domenowe SPA — lustro kontraktu `apps/server` (enumy `db/schema/enums.ts` + kody błędów),
 * NIE import cross-package (§Approach planu: toolchainy Vite/ESM i Nest/CommonJS celowo rozdzielone). */

export type MemoryKind = 'fact' | 'document';
export type MemoryScope = 'global' | 'project';
export type MemoryStatus = 'approved' | 'archived' | 'purged';
export type MemorySource = 'agent' | 'human' | 'nightly';

export type ProposalType = 'create' | 'update' | 'merge' | 'delete';
export type ProposalOrigin = 'agent' | 'human' | 'nightly';
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export type RevisionAction = 'created' | 'edited' | 'promote' | 'archive' | 'superseded_by';

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
  | 'secret_blocked'
  | 'purge_tombstone'
  | 'nightly_run'
  | 'backup_completed';
