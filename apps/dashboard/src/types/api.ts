import type {
  AuditEventType,
  EffectiveTokenStatus,
  MemoryKind,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  ProjectTokenState,
  ProposalErrorCode,
  ProposalOrigin,
  ProposalStatus,
  ProposalType,
  RelationType,
  RevisionAction,
} from './domain';

/** Kontrakty odpowiedzi `/api/*` (§M4 planu Fazy 5) — lustro DTO serwera (`apps/server/src/dashboard/*.controller.ts`
 * + `proposals.types.ts`/`memory-admin.service.ts`), NIE import cross-package (patrz `types/domain.ts`). */

export interface ProposalPayloadShape {
  memoryId?: string;
  header?: string;
  body?: string;
  tags?: string[];
  kind?: MemoryKind;
  /** Attach-on-save (roadmap v1.2, "memory-relations + 1-hop graph boost") — lustro
   * `RelationPayloadEntry`/`CreatePayload.relations`/`UpdatePayload.relations`
   * (`apps/server/src/proposals/proposals.types.ts`); materializowane dopiero w `ProposalsService.approve()`,
   * NIE tutaj. Renderowane w kolejce PRZED akceptacją (`QueueScreen.tsx` → `ProposalRelations`,
   * FINDING 1 review PR #15) — recenzent musi widzieć krawędzie, które approve utworzy. */
  relations?: { type: RelationType; targetId: string }[];
}

export interface ProposalView {
  id: string;
  type: ProposalType;
  origin: ProposalOrigin;
  status: ProposalStatus;
  payload: ProposalPayloadShape;
  editedPayload: ProposalPayloadShape | null;
  affectedIds: string[];
  baseVersions: Record<string, number>;
  scope: MemoryScope;
  projectId: string | null;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
  stale: boolean;
  staleIds: string[];
}

export interface ApproveResult {
  proposalId: string;
  materializedId?: string;
  archivedIds: string[];
  embedding: 'promoted' | 'recomputed' | 'vectorless';
}

export interface EditProposalResult {
  warnings: string[];
}

/** Lustro `BulkDecisionItemError`/`BulkDecisionResult` (`apps/server/src/proposals/proposals.types.ts`,
 * roadmap v1.3 "Bulk approve/reject w kolejce") — `unknown` dołożone obok `ProposalErrorCode`, bo
 * `runBulk` po stronie serwera łapie też błędy spoza kontraktu domenowego (§`toBulkItemError`). */
export type BulkFailureCode = ProposalErrorCode | 'unknown';

export interface BulkDecisionItemError {
  id: string;
  code: BulkFailureCode;
  message: string;
  /** Wyłącznie dla `code='stale'` — te same id co w kopercie 409 pojedynczego approve. */
  staleIds?: string[];
}

export interface BulkDecisionResult {
  /** Kolejność zgodna z (odduplikowanym) wejściem — bulk jest sekwencyjny. */
  succeeded: string[];
  failed: BulkDecisionItemError[];
}

/** `WithWarnings` serwera (`memory-admin.service.ts`) — zwracane przez human-create/edit pamięci. */
export interface WithWarnings {
  warnings: string[];
}

export interface MemoryListItem {
  id: string;
  header: string;
  kind: MemoryKind;
  tags: string[];
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  source: MemorySource;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Tylko `kind=event` (roadmap v1.2, "kind=event episodic") — null dla fact/document. */
  eventTime: string | null;
}

export interface MemoryDetail extends MemoryListItem {
  body: string;
  approvedAt: string | null;
}

/** Zakładka "Relacje" (roadmap v1.2, "memory-relations + 1-hop graph boost") — lustro
 * `RelationListItem` (`apps/server/src/memory/memory-admin.service.ts`). */
export interface RelationListItemApi {
  id: string;
  type: RelationType;
  direction: 'outgoing' | 'incoming';
  source: MemorySource;
  createdAt: string;
  neighbor: { id: string; header: string; kind: MemoryKind; status: MemoryStatus };
}

export interface RevisionRowApi {
  id: string;
  memoryId: string;
  action: RevisionAction;
  actor: string;
  snapshot: Record<string, unknown> | null;
  supersedes: string | null;
  supersededBy: string | null;
  createdAt: string;
}

export interface HumanCreateResponse {
  id: string;
  warnings: string[];
}

/** Zgrupowane liczniki tokenów per projekt (roadmap v1.3, "Wiele tokenów per projekt + graceful
 * rotation") — lustro `TokenCounts` (`apps/server/src/projects/projects.service.ts`). Zastępuje
 * dawne `tokenStatus`/`tokenHash`/`tokenRotatedAt` (1 token = 1 status → N tokenów = liczniki). */
export interface TokenCounts {
  active: number;
  grace: number;
  revoked: number;
}

export interface ProjectListItem {
  id: string;
  name: string;
  createdAt: string;
  memoryCount: number;
  tokenCounts: TokenCounts;
  /** Per-projektowy toggle (roadmap v1.2, "kind=event episodic") — czy `event` dokłada się do
   * domyślnego `kind` w `search_memory` gdy agent go nie poda jawnie. Edytowany w
   * `ProjectSettingsDialog`. */
  includeEventsInDefaultSearch: boolean;
}

/** Lustro `ProjectTokenDto` (`apps/server/src/dashboard/projects.controller.ts`) — wiersz w dialogu
 * "Tokeny". NIGDY nie niesie `token_hash`/plaintext tokena (patrz `TokenReveal` dla jednorazowego
 * reveal, osobna ścieżka). */
export interface ProjectTokenApi {
  id: string;
  projectId: string;
  label: string;
  status: ProjectTokenState;
  effectiveStatus: EffectiveTokenStatus;
  createdAt: string;
  graceStartedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** Atrybucja wyszukań ostatnich 30 dni (§0 pkt 7 planu v1.3 — per-token breakdown na "Pomiary"
   * odłożone, to jest jedyna widoczna atrybucja w tym passie). */
  searches30d: number;
}

export interface CreatedProject {
  project: Omit<ProjectListItem, 'memoryCount' | 'tokenCounts'>;
  token: string;
  tokenRow: ProjectTokenApi;
}

/** Wynik `createToken`/`rotateToken` (roadmap v1.3) — token widoczny RAZ + jego publiczny wiersz. */
export interface CreatedTokenApi {
  token: string;
  tokenRow: ProjectTokenApi;
}

/** `rotateToken` zwraca też stary wiersz (teraz w `grace`) — `TokenReveal` pokazuje jego `expiresAt`
 * jako deadline karencji. */
export interface RotatedTokenApi extends CreatedTokenApi {
  previousTokenRow: ProjectTokenApi;
}

export interface AuditLogRowApi {
  id: string;
  eventType: AuditEventType;
  actor: string;
  affectedIds: string[];
  revisionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface DashboardMetrics {
  queueDepth: number;
  embedding: { status: 'up' | 'down'; model: string; latencyMs: number | null };
  secretBlocked24h: number;
  nightlyRun: { at: string; metadata: Record<string, unknown> | null } | null;
  lastBackup: { at: string; metadata: Record<string, unknown> | null } | null;
}

export interface DashboardLimits {
  headerMaxLen: number;
  bodyMaxFact: number;
  bodyMaxDocument: number;
  /** `kind=event` (roadmap v1.2, "kind=event episodic") — licznik znaków w `HumanCreateDialog`. */
  bodyMaxEvent: number;
  tagsMax: number;
  tagMaxLen: number;
  /** Ekran "Onboarding" (roadmap v1.2) — publiczny origin `/mcp`, `null` gdy operator nie
   * skonfigurował ani `PUBLIC_MCP_URL`, ani `ACME_DOMAIN`. */
  mcpPublicUrl: string | null;
}

/** Ekran "Pomiary" (roadmap v1.1) — lustro `UsageMetricsDto`
 * (`apps/server/src/dashboard/usage-metrics.controller.ts`). */
export type UsageBucket = 'day' | 'hour';

export interface UsageBucketPoint {
  ts: string;
  searches: number;
  zeroResult: number;
  degraded: number;
}

export interface ProjectSearchSeries {
  projectId: string;
  projectName: string;
  /** Headline "zero-result rate per projekt" — sumy dla całego zakresu. `degraded` WYŁĄCZONE
   * z `zeroResult`/`zeroResultRate` (degradacja embeddingu ≠ "pamięć nie ma treści"). */
  totals: { searches: number; zeroResult: number; degraded: number; zeroResultRate: number };
  buckets: UsageBucketPoint[];
}

export interface ProposalOutcomeBucketPoint {
  ts: string;
  approved: number;
  rejected: number;
  /** PODZBIÓR `approved` (approved AND miał edited_payload) — NIE osobna rozłączna kategoria. */
  approvedWithEdits: number;
}

export interface UsageMetrics {
  range: { from: string; to: string; bucket: UsageBucket };
  searchSeries: ProjectSearchSeries[];
  searchTotals: { searches: number; zeroResult: number; degraded: number; zeroResultRate: number };
  proposalSeries: {
    buckets: ProposalOutcomeBucketPoint[];
    totals: { approved: number; rejected: number; approvedWithEdits: number };
  };
}

/** Ekran "Operacje" (roadmap v1.1) — lustro `NightlyCounters`/`NightlyRunResult`
 * (`apps/server/src/nightly/nightly.types.ts`). */
export interface NightlyCounters {
  created: number;
  withdrawn: number;
  skippedAsDup: number;
  mergeProposed: number;
  pruneProposed: number;
  skippedPoliteness: number;
  skippedCap: number;
  /** Wiersze `search_events` usunięte retencją, piggyback na tym samym przebiegu (roadmap v1.1
   * "Pomiary"). */
  searchEventsPruned: number;
}

export interface NightlyRunResult {
  status: 'success' | 'failed' | 'skipped-locked';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  counters: NightlyCounters;
}

/** Hard-purge (roadmap v1.1) — lustro `PurgePreview`/`PurgeResult` (`apps/server/src/purge/purge.service.ts`). */
export interface PurgePreview {
  id: string;
  status: MemoryStatus;
  header: string;
  embeddingsCount: number;
  relatedProposalsCount: number;
  revisionsWithContentCount: number;
  /** Roadmap v1.2 — krawędzie `memory_relations` dotykające tę pamięć. */
  relationsCount: number;
}

export interface PurgeResult {
  id: string;
  embeddingsDeleted: number;
  stagingEmbeddingsDeleted: number;
  proposalsRedacted: number;
  revisionsRedacted: number;
  /** Roadmap v1.2 — krawędzie usunięte razem z tombstone'em. */
  relationsDeleted: number;
}
