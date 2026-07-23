import type {
  AuditEventType,
  MemoryKind,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  ProposalOrigin,
  ProposalStatus,
  ProposalType,
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
}

export interface MemoryDetail extends MemoryListItem {
  body: string;
  approvedAt: string | null;
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

export interface ProjectListItem {
  id: string;
  name: string;
  tokenHash: string | null;
  tokenStatus: 'none' | 'active' | 'rotated';
  createdAt: string;
  tokenRotatedAt: string | null;
  memoryCount: number;
}

export interface CreatedProject {
  project: Omit<ProjectListItem, 'memoryCount'>;
  token: string;
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
}

export interface PurgeResult {
  id: string;
  embeddingsDeleted: number;
  stagingEmbeddingsDeleted: number;
  proposalsRedacted: number;
  revisionsRedacted: number;
}
