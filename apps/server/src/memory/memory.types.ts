import type { MemoryKind, MemoryScope } from '../db/schema/enums';

/** `kind` dopuszczalny w `save_memory` (agent) — `event` jest human-only, więc wykluczony na
 * poziomie typu TS (obok zod enum w `mcp-server.factory.ts`, defense in depth). */
export type SaveMemoryKind = Extract<MemoryKind, 'fact' | 'document'>;

export interface SaveMemoryInput {
  header: string;
  body: string;
  tags?: string[];
  /** Domyślnie `fact` (`save()` liczy `input.kind ?? 'fact'`) — istniejący wywołujący bez `kind`
   * zachowują się jak przed dodaniem `document`. */
  kind?: SaveMemoryKind;
  /** Opcjonalne — id istniejącej `fact`/`document` pamięci WŁASNEGO projektu, którą `header`+`body`
   * mają POPRAWIĆ w miejscu (zamiast tworzyć nową, luźną pamięć). Mapowane na proposal
   * `type='update'`, `origin='agent'` (reużywa istniejący update approve-branch), patrz
   * `MemoryService.saveAsSupersede`. `event`/`global`/inny projekt/nieznane id → błąd. */
  supersedes?: string;
}

export type SaveStatus = 'pending' | 'duplicate_pending' | 'already_exists';

export interface SaveMemoryResult {
  id: string;
  status: SaveStatus;
}

/** Filtr `kind` w search_memory — fact|document|event; brak = domyślnie fact+document (FR-M1),
 * `event` dokłada się do domyślnego zestawu tylko gdy projekt ma włączony
 * `includeEventsInDefaultSearch` (roadmap v1.2, "kind=event episodic"). */
export type MemoryKindFilter = Extract<MemoryKind, 'fact' | 'document' | 'event'>;

export interface SearchMemoryInput {
  query: string;
  tags?: string[];
  kind?: MemoryKindFilter;
}

export interface SearchResultItem {
  id: string;
  header: string;
  tags: string[];
  score: number;
  /** Tylko `kind=document` (FR-M1): fragment najlepiej dopasowanego chunku wektorowego.
   * Nieobecny przy ramieniu FTS-only (embedding-down) — pole czysto addytywne. */
  excerpt?: string;
}

export interface GetMemoryResult {
  id: string;
  header: string;
  body: string;
  kind: MemoryKind;
  tags: string[];
  scope: MemoryScope;
  projectId: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Tylko `kind=event` (roadmap v1.2) — null dla fact/document. */
  eventTime: string | null;
}

/** [DEV-ONLY] Wejście dla `MemoryService.devSeedApproved` (CLI `seed-memory`, patrz zadanie pkt D). */
export interface SeedApprovedInput {
  header: string;
  body: string;
  kind: MemoryKind;
  tags?: string[];
  scope: MemoryScope;
  projectId?: string | null;
}
