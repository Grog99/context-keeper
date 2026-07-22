import type { MemoryKind, MemoryScope } from '../db/schema/enums';

export interface SaveMemoryInput {
  header: string;
  body: string;
  tags?: string[];
}

export type SaveStatus = 'pending' | 'duplicate_pending' | 'already_exists';

export interface SaveMemoryResult {
  id: string;
  status: SaveStatus;
}

/** Filtr `kind` w search_memory — fact|document; brak = domyślnie oba (FR-M1). */
export type MemoryKindFilter = Extract<MemoryKind, 'fact' | 'document'>;

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
