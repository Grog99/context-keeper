import { pgEnum } from 'drizzle-orm/pg-core';

// `kind` opisuje czym pamięć JEST. `event` (roadmap v1.2, "kind=event episodic") — zdarzenie z
// osobnym backdatable `event_time`, tworzone TYLKO przez człowieka (dashboard); agent's
// `save_memory` go nie eksponuje.
export const memoryKind = pgEnum('memory_kind', ['fact', 'document', 'event']);
export const memoryScope = pgEnum('memory_scope', ['global', 'project']);
// `purged` = hard-purge (FR-S3, §10 tech-stack) — treść wymazana we wszystkich content-bearing
// tabelach, wiersz zostaje jako tombstone (audit `purge_tombstone`). Nieodwracalne, wyłącznie CLI.
export const memoryStatus = pgEnum('memory_status', ['approved', 'archived', 'purged']);
// `source` = autorstwo (kto utworzył), trzymane osobno od `kind`.
export const memorySource = pgEnum('memory_source', ['agent', 'human', 'nightly']);

// Słownik typów relacji (roadmap v1.2, "memory-relations + 1-hop graph boost") — świadomie
// zamknięty, DOKŁADNIE 3 wartości (locked decision planu, nie pojedyncza nietypowana `relates_to`).
// Trzymany w sync z zod enumem `relations[].type` w `mcp-server.factory.ts` (save_memory).
export const relationType = pgEnum('relation_type', ['caused_by', 'follows', 'context_for']);

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
  // roadmap v1.2 ("kind=event episodic") — zmiana ustawień projektu z dialogu szczegółów na
  // ekranie "Projekty i tokeny" (dziś tylko `include_events_in_default_search`).
  'project_settings_changed',
  // roadmap v1.2 ("memory-relations + 1-hop graph boost") — utworzenie/usunięcie krawędzi
  // `memory_relations`, przez agenta (materializacja w `ProposalsService.approve`) albo człowieka
  // (dashboard, `MemoryAdminService`).
  'relation_created',
  'relation_removed',
]);

// Aliasy TS dla wartości enumów (Faza 2+) — jedno źródło prawdy (enumValues), bez duplikowania literałów.
export type MemoryKind = (typeof memoryKind.enumValues)[number];
export type MemoryScope = (typeof memoryScope.enumValues)[number];
export type MemoryStatus = (typeof memoryStatus.enumValues)[number];
export type MemorySource = (typeof memorySource.enumValues)[number];
export type RelationType = (typeof relationType.enumValues)[number];
export type ProposalType = (typeof proposalType.enumValues)[number];
export type ProposalOrigin = (typeof proposalOrigin.enumValues)[number];
export type ProposalStatus = (typeof proposalStatus.enumValues)[number];
export type RevisionAction = (typeof revisionAction.enumValues)[number];
export type AuditEventType = (typeof auditEventType.enumValues)[number];
