import type { MemoryKind, MemoryScope, RelationType } from '../db/schema/enums';

/** `kind` dopuszczalny w `save_memory` (agent) — roadmap v1.3 "kind=event przez agenta" znosi
 * ograniczenie human-only: `event` dołączył do `fact`/`document`; roadmap v1.8 dokłada `journal`
 * (dziennik pisze wyłącznie agent). `Extract` zostaje (nie zwykły alias `MemoryKind`), żeby typ
 * dalej mówił "to podzbiór dopuszczalny dla agenta", nie "cały enum". */
export type SaveMemoryKind = Extract<MemoryKind, 'fact' | 'document' | 'event' | 'journal'>;

/** Jeden wpis `relations[]` w `save_memory` (roadmap v1.2, "memory-relations + 1-hop graph boost",
 * ATTACH-ON-SAVE — locked decision planu). Krawędź kierunkowa OD zapisywanej/poprawianej pamięci DO
 * `targetId` — patrz `MemoryService.resolveRelations`. */
export interface SaveRelationInput {
  type: RelationType;
  targetId: string;
}

export interface SaveMemoryInput {
  header: string;
  body: string;
  tags?: string[];
  /** Domyślnie `fact` (`save()` liczy `input.kind ?? 'fact'`) — istniejący wywołujący bez `kind`
   * zachowują się jak przed dodaniem `document`. */
  kind?: SaveMemoryKind;
  /** Wymagany gdy `kind='event'` (roadmap v1.3, "kind=event przez agenta") — ISO 8601, backdate
   * bez ograniczeń, daty przyszłe dozwolone. Ta sama reguła co human-create: `validateEventTime`.
   * Podanie przy `kind` innym niż `event` to twardy `validation_error` (`MemoryService.save`). */
  eventTime?: string;
  /** Opcjonalne — id istniejącej `fact`/`document` pamięci WŁASNEGO projektu, którą `header`+`body`
   * mają POPRAWIĆ w miejscu (zamiast tworzyć nową, luźną pamięć). Mapowane na proposal
   * `type='update'`, `origin='agent'` (reużywa istniejący update approve-branch), patrz
   * `MemoryService.saveAsSupersede`. `event`/`journal`/`global`/inny projekt/nieznane id → błąd
   * (nie dla event/journal: korekta dziennika = nowy wpis). */
  supersedes?: string;
  /** Opcjonalne — typowane krawędzie OD tej pamięci DO istniejących pamięci WŁASNEGO projektu
   * (max `MAX_RELATIONS_PER_SAVE`). Rider na TYM SAMYM proposalu (create/update) —
   * materializowane dopiero w `ProposalsService.approve()`, patrz `MemoryService.resolveRelations`. */
  relations?: SaveRelationInput[];
}

/** `approved` (roadmap v1.6, A2) — wyłącznie auto mode: zapis przeszedł bezpieczniki i został od razu
 * zatwierdzony; `id` to wtedy id PAMIĘCI (przy `supersedes` — korygowanego celu), nie propozycji. */
export type SaveStatus = 'pending' | 'duplicate_pending' | 'already_exists' | 'approved';

export interface SaveMemoryResult {
  id: string;
  status: SaveStatus;
}

/** Filtr `kind` w search_memory — fact|document|event|journal; brak = domyślnie fact+document (FR-M1),
 * `event` dokłada się do domyślnego zestawu tylko gdy projekt ma włączony
 * `includeEventsInDefaultSearch` (roadmap v1.2, "kind=event episodic"). `journal` NIGDY nie jest w
 * domyślnym zestawie (roadmap v1.8) — tylko jawne `kind: 'journal'` albo `list_journal`. */
export type MemoryKindFilter = Extract<MemoryKind, 'fact' | 'document' | 'event' | 'journal'>;

/** `list_journal` (roadmap v1.8) — domyślna i maksymalna liczba zwracanych wpisów. Stałe, bez env
 * (duch ustalenia #31: nie mnożymy knobów dla narzędzia, które i tak zwraca same nagłówki). */
export const LIST_JOURNAL_DEFAULT_LIMIT = 10;
export const LIST_JOURNAL_MAX_LIMIT = 50;

export interface ListJournalInput {
  limit?: number;
}

/** Element wyniku `list_journal` — wyłącznie nagłówek; treść przez `get_memory(id)`. `createdAt` =
 * moment zapisu wpisu przez agenta (także przy human-gate, patrz `materializeMemory`). */
export interface JournalListItem {
  id: string;
  header: string;
  tags: string[];
  createdAt: string;
}

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
  /** Tylko w trybie cross-project (`all_projects`, roadmap v1.5): slug projektu-źródła wyniku, `null`
   * dla pamięci `global`. W trybie domyślnym pola NIE MA — odpowiedź bajt w bajt jak przed v1.5. */
  project?: string | null;
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
