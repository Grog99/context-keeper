import type {
  MemoryKind,
  MemoryScope,
  ProposalOrigin,
  ProposalStatus,
  ProposalType,
} from '../db/schema/enums';

/** Payload `type=create` — dokładnie kształt, jaki `MemoryService.save()` zapisuje do `proposals.payload`
 * (Faza 4 seam, patrz `memory.service.ts:118-120`). */
export interface CreatePayload {
  memoryId: string;
  header: string;
  body: string;
  tags: string[];
  kind: MemoryKind;
}

/** Payload `type=update` — patch (pola pominięte = "bez zmian", scalane z aktualnym wierszem
 * w `ProposalsService.approve` PRZED materializacją i (re)embeddingiem). `affectedIds=[memoryId]`. */
export interface UpdatePayload {
  memoryId: string;
  header?: string;
  body?: string;
  tags?: string[];
  kind?: MemoryKind;
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

export type ProposalPayload = CreatePayload | UpdatePayload | MergePayload | DeletePayload;

export type EmbeddingDisposition = 'promoted' | 'recomputed' | 'vectorless';

export interface ApproveResult {
  proposalId: string;
  /** Id nowo zmaterializowanej pamięci (create/merge) albo id zaktualizowanej (update). Brak dla delete. */
  materializedId?: string;
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
