import { pgEnum } from 'drizzle-orm/pg-core';

// `kind` opisuje czym pamięć JEST (rozszerzalny — `event` dojdzie w v2 przez ALTER TYPE ... ADD VALUE).
export const memoryKind = pgEnum('memory_kind', ['fact', 'document']);
export const memoryScope = pgEnum('memory_scope', ['global', 'project']);
export const memoryStatus = pgEnum('memory_status', ['approved', 'archived']);
// `source` = autorstwo (kto utworzył), trzymane osobno od `kind`.
export const memorySource = pgEnum('memory_source', ['agent', 'human', 'nightly']);

export const proposalType = pgEnum('proposal_type', ['create', 'update', 'merge', 'delete']);
export const proposalOrigin = pgEnum('proposal_origin', ['agent', 'human', 'nightly']);
// `withdrawn` = samo-wycofanie maszynowe (nocny job, Faza 6) — odróżnione od `rejected` (decyzja
// human) mimo podobnego skutku (zamknięcie bez materializacji), bo audyt ma pokazywać KTO zdecydował.
export const proposalStatus = pgEnum('proposal_status', ['pending', 'approved', 'rejected', 'withdrawn']);

// Stan tokena projektu: none = jeszcze nie wygenerowany.
export const projectTokenStatus = pgEnum('project_token_status', ['none', 'active', 'rotated']);

export const revisionAction = pgEnum('revision_action', [
  'created',
  'edited',
  'promote',
  'archive',
  'superseded_by',
]);

// Append-only audit (§4). Odczyty nie logowane per-event.
export const auditEventType = pgEnum('audit_event_type', [
  'proposal_created',
  'proposal_approved',
  'proposal_rejected',
  'proposal_edited',
  'human_edit',
  'archive',
  'promote',
  'token_created',
  'token_rotated',
  'secret_blocked',
  'purge_tombstone',
  'nightly_run',
  'backup_completed',
]);

// Aliasy TS dla wartości enumów (Faza 2+) — jedno źródło prawdy (enumValues), bez duplikowania literałów.
export type MemoryKind = (typeof memoryKind.enumValues)[number];
export type MemoryScope = (typeof memoryScope.enumValues)[number];
export type MemoryStatus = (typeof memoryStatus.enumValues)[number];
export type MemorySource = (typeof memorySource.enumValues)[number];
export type ProposalType = (typeof proposalType.enumValues)[number];
export type ProposalOrigin = (typeof proposalOrigin.enumValues)[number];
export type ProposalStatus = (typeof proposalStatus.enumValues)[number];
export type RevisionAction = (typeof revisionAction.enumValues)[number];
export type AuditEventType = (typeof auditEventType.enumValues)[number];
