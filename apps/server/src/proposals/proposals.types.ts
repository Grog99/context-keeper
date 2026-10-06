import type {
  MemoryKind,
  MemoryScope,
  ProposalOrigin,
  ProposalStatus,
  ProposalType,
  RelationType,
} from '../db/schema/enums';
import type { ProposalErrorCode } from './proposals.errors';

/** Krawędź attach-on-save, niesiona w `payload.relations` (§memory.types.ts `SaveRelationInput`,
 * §db/schema/memory-relations.ts) — dokładnie ten sam kształt na `CreatePayload` i `UpdatePayload`,
 * bo obie ścieżki `MemoryService.save()` (create i `saveAsSupersede`) mogą je nieść. */
export interface RelationPayloadEntry {
  type: RelationType;
  targetId: string;
}

/** Payload `type=create` — dokładnie kształt, jaki `MemoryService.save()` zapisuje do `proposals.payload`
 * (Faza 4 seam, patrz `memory.service.ts:118-120`). */
export interface CreatePayload {
  memoryId: string;
  header: string;
  body: string;
  tags: string[];
  kind: MemoryKind;
  /** Tylko `kind='event'` (roadmap v1.3, "kind=event przez agenta") — ISO 8601 string (payload to
   * jsonb, więc nigdy `Date`); przepisywane do `memories.event_time` w `materializeMemory`. */
  eventTime?: string;
  /** Attach-on-save (roadmap v1.2) — materializowane W `ProposalsService.approve()`, NIE tutaj;
   * `undefined`/`[]` = bez krawędzi (backward-compat, pole czysto addytywne). */
  relations?: RelationPayloadEntry[];
}

/** Payload `type=update` — patch (pola pominięte = "bez zmian", scalane z aktualnym wierszem
 * w `ProposalsService.approve` PRZED materializacją i (re)embeddingiem). `affectedIds=[memoryId]`. */
export interface UpdatePayload {
  memoryId: string;
  header?: string;
  body?: string;
  tags?: string[];
  kind?: MemoryKind;
  /** Attach-on-save (roadmap v1.2) — jak w `CreatePayload`, tylko dla `saveAsSupersede`. */
  relations?: RelationPayloadEntry[];
}

/** Payload `type=merge` — pełny kształt wynikowej pamięci C (`memoryId` = id domintowany dla C,
 * analogicznie do create). `affectedIds` = [A, B, …] archiwizowane przy akceptacji. */
export interface MergePayload {
  memoryId: string;
  header: string;
  body: string;
  tags: string[];
  kind: MemoryKind;
}

/** Payload `type=delete` — sama referencja, `affectedIds=[memoryId]` niesie to, co ma być archiwizowane. */
export interface DeletePayload {
  memoryId: string;
}

/** Payload `type=create_project` (roadmap v1.5, scope B) — propozycja założenia projektu przez agenta z
 * tokenem konta. `slug` ZAWSZE znormalizowany (trim + lowercase, `normalizeProjectSlugInput`), `name`
 * znormalizowany (`normalizeProjectName`). `affectedIds=[]`, `scope='global'`, `project_id=NULL`.
 *
 * NIEZMIENNIK (partial unique index `proposals_create_project_slug_pending_key`, migracja 0013, oraz
 * `ProjectSlugService.isSlugPending`): WYŁĄCZNIE ten payload ma klucz `slug` na najwyższym poziomie.
 * Predykat indeksu nie może odwołać się do wartości enuma (55P04), więc to klucz `slug` wyróżnia
 * propozycje projektu — payload żadnego innego typu NIE MOŻE dostać pola `slug`. */
export interface CreateProjectPayload {
  name: string;
  slug: string;
}

export type ProposalPayload =
  | CreatePayload
  | UpdatePayload
  | MergePayload
  | DeletePayload
  | CreateProjectPayload;

/** Typy propozycji będące mutacją PAMIĘCI (mają `header`/`body`/`memoryId`) — `create_project` jest poza
 * tym zbiorem (tworzy projekt, nie dotyka `memories`). Używane tam, gdzie kod zakłada semantykę pamięci
 * (np. `edit()`). */
export const MEMORY_PROPOSAL_TYPES = ['create', 'update', 'merge', 'delete'] as const;
export type MemoryProposalType = (typeof MEMORY_PROPOSAL_TYPES)[number];

export function isMemoryProposalType(type: ProposalType): type is MemoryProposalType {
  return (MEMORY_PROPOSAL_TYPES as readonly ProposalType[]).includes(type);
}

export type EmbeddingDisposition = 'promoted' | 'recomputed' | 'vectorless';

export interface ApproveResult {
  proposalId: string;
  /** Id nowo zmaterializowanej pamięci (create/merge) albo id zaktualizowanej (update). Brak dla delete. */
  materializedId?: string;
  /** Id nowo utworzonego projektu — wyłącznie dla `type=create_project` (`materializedId` zostaje
   * czysto memory-owe). */
  projectId?: string;
  /** Id-y zarchiwizowane w ramach tej akceptacji (merge/delete/supersedes na create). */
  archivedIds: string[];
  embedding: EmbeddingDisposition;
}

export interface ApproveOptions {
  /** Aktor do `revisions.actor`/audytu — np. `human-dashboard` albo `human:<kto>` (CLI: `--actor`). */
  actor: string;
  /** Supersession (FR-Q8) — WYŁĄCZNIE dla proposali `type=create`: id pamięci zastępowanej przez N. */
  supersedes?: string;
  /** Opcjonalny stale-guard dla `supersedes` (poza standardowym `base_versions` proposala). */
  expectedSupersedeVersion?: number;
}

export interface RejectOptions {
  actor: string;
  reason?: string;
}

export interface EditInput {
  header?: string;
  body?: string;
  tags?: string[];
}

export interface EditOptions {
  actor: string;
}

export interface EditResult {
  /** Ostrzeżenia non-blocking (np. skaner sekretów przy human-edit, FR-S1) — treść i tak zapisana. */
  warnings: string[];
}

export interface ListProposalsFilter {
  status?: ProposalStatus;
  origin?: ProposalOrigin;
  projectId?: string;
}

/** Widok proposala do listy/podglądu (CLI dziś, dashboard w Fazie 5) — `payload`/`editedPayload`
 * płytko otypowane jako `ProposalPayload` (jsonb w bazie jest untyped, patrz `db/schema/proposals.ts`). */
export interface ProposalView {
  id: string;
  type: ProposalType;
  origin: ProposalOrigin;
  status: ProposalStatus;
  payload: ProposalPayload;
  editedPayload: ProposalPayload | null;
  affectedIds: string[];
  baseVersions: Record<string, number>;
  scope: MemoryScope;
  projectId: string | null;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
  /** Obliczane przy odczycie, BEZ locka (display-only, §1.2/2.4 planu): czy którykolwiek affected_id
   * ma teraz `memories.version` inny niż zapisany w `base_versions`, albo w ogóle zniknął. */
  stale: boolean;
  staleIds: string[];
}

/** Decyzja zbiorcza (roadmap v1.3, "Bulk approve/reject w kolejce") — CZYSTA ORKIESTRACJA nad
 * `approve()`/`reject()`: każdy id nadal dostaje własną transakcję, własne row-locki i własny wpis
 * audytu. `unknown` = błąd spoza kontraktu domenowego (np. padnięta baza) — złapany per item, żeby
 * jeden wyjątek nie ubił podsumowania dla itemów, które JUŻ się wykonały (bulk nie jest atomowy). */
export interface BulkDecisionItemError {
  id: string;
  code: ProposalErrorCode | 'unknown';
  message: string;
  /** Wyłącznie dla `code='stale'` — te same id co w kopercie 409 pojedynczego approve. */
  staleIds?: string[];
}

export interface BulkDecisionResult {
  /** Kolejność zgodna z (odduplikowanym) wejściem — bulk jest sekwencyjny. */
  succeeded: string[];
  failed: BulkDecisionItemError[];
}

export interface BulkApproveOptions {
  actor: string;
}

/** `reason` jeden, wspólny — trafia do audytu KAŻDEJ odrzucanej propozycji (decyzja produktowa). */
export interface BulkRejectOptions {
  actor: string;
  reason?: string;
}
