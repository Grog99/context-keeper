import type {
  MemoryKind,
  MemoryScope,
  ProposalOrigin,
  ProposalStatus,
  ProposalType,
  RelationType,
} from '../db/schema/enums';
import type { KeysetPosition } from '../common/keyset-cursor';
import type { AutoHoldReason } from '../db/schema/proposals';
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

/** Detektory nocnego joba oparte na modelu (roadmap v1.6; B2 prune, B3 dołoży 'llm-conflicts'). */
export const LLM_DETECTORS = ['llm-prune'] as const;
export type LlmDetector = (typeof LLM_DETECTORS)[number];

/** Kategorie werdyktu (G1/G5) — maszynowo czytelne; B3 dołoży 'contradiction'. */
export const LLM_PRUNE_CATEGORIES = ['ephemeral', 'empty', 'verbose', 'untidy'] as const;
export type ProposalRationaleCategory = (typeof LLM_PRUNE_CATEGORIES)[number];

/** Werdykt detektora LLM zapisany w payloadzie (G4): kategoria + uzasadnienie dla recenzenta. Zapis
 * rozumowania maszyny, NIE treść pamięci — approve go ignoruje, edit-before-approve go zachowuje (`...base`).
 * Obecność = znacznik „warunek z detektora LLM" dla `reconcile` (ust. 13, wyłączenie z orphan-withdraw). */
export interface ProposalRationale {
  detector: LlmDetector;
  category: ProposalRationaleCategory;
  reason: string;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Czy payload niesie werdykt detektora LLM (znacznik ust. 13). Defensywnie — payload to nietypowany jsonb. */
export function isLlmDetectedPayload(payload: unknown): boolean {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.rationale)) return false;
  const detector = payload.rationale.detector;
  return typeof detector === 'string' && (LLM_DETECTORS as readonly string[]).includes(detector);
}

/** Payload `type=update` — patch (pola pominięte = "bez zmian", scalane z aktualnym wierszem
 * w `ProposalsService.approve` PRZED materializacją i (re)embeddingiem). `affectedIds=[memoryId]`.
 * Nocny job (detektor LLM prune) produkuje `update` wyłącznie z `header`/`body`/`tags` — nigdy `kind`. */
export interface UpdatePayload {
  memoryId: string;
  header?: string;
  body?: string;
  tags?: string[];
  kind?: MemoryKind;
  /** Attach-on-save (roadmap v1.2) — jak w `CreatePayload`, tylko dla `saveAsSupersede`. */
  relations?: RelationPayloadEntry[];
  /** Werdykt detektora LLM (G4) — opcjonalny: brak przy update agenta i edycji człowieka (wstecznie zgodne). */
  rationale?: ProposalRationale;
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

/** Payload `type=delete` — referencja, `affectedIds=[memoryId]` niesie to, co ma być archiwizowane.
 * `rationale` (opcjonalne) dokłada tylko detektor LLM; recency prune go nie ma i działa jak dotąd. */
export interface DeletePayload {
  memoryId: string;
  rationale?: ProposalRationale;
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
  /** v1.6 A2 — ustawiane wyłącznie przez `MemoryService.save()`: auto-akceptacja maszynowa (w transakcji
   * blokuje wiersz projektu, przelicza limit okna 24 h i oznacza `auto_approved_at`). Dozwolona tylko
   * dla propozycji agenta `create`/`update` (bez `supersedes`); nocny job i `create_project` nigdy. */
  auto?: boolean;
  /** `false` = gdy brak stagingu embeddingu, NIE wołaj providera (zostaje `vectorless`). Domyślnie `true`. */
  recomputeEmbedding?: boolean;
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
  /** Typ propozycji — filtr w SQL (nightly-scale, ustalenie 6). */
  type?: ProposalType;
  /** `'global'` = tylko propozycje o `scope='global'` (druga forma kontekstu przełącznika, FR-D6, obok
   * `projectId`); pominięte = bez filtra zakresu. */
  scope?: MemoryScope;
}

/** Filtr lekkiej, stronicowanej listy kolejki (`ProposalsService.listPendingPage`). */
export interface ListProposalsPageFilter extends ListProposalsFilter {
  /** Domyślnie `PROPOSALS_LIST_DEFAULT_LIMIT`, max `PROPOSALS_LIST_MAX_LIMIT`. */
  limit?: number;
  /** Keyset `(created_at, id)` ASC — pozycja ostatniego wiersza poprzedniej strony. */
  cursor?: KeysetPosition;
}

/** Pola wiersza kolejki wyprowadzone z EFEKTYWNEGO payloadu (`coalesce(edited_payload, payload)`) —
 * liczone w SQL, więc sam jsonb nigdy nie opuszcza Postgresa przy liście (nightly-scale G3; payload do
 * 256 KB × strona × polling co 15 s to był koszt z tech-review #5). Pola nieobecne w payloadzie
 * danego typu (np. `header` w `delete`, `name`/`slug` poza `create_project`) są `null`. */
export interface ProposalListSummary {
  header: string | null;
  kind: MemoryKind | null;
  tags: string[];
  memoryId: string | null;
  name: string | null;
  slug: string | null;
}

/** Lekki element listy kolejki — BEZ `payload`/`editedPayload`/`baseVersions` (pełny widok po
 * `GET /api/proposals/:id` -> `ProposalView`). Znacznik „ma podpowiedź" wiersza (A1, ticket
 * near-duplicate-detection, G10) to `hasSimilar`, liczony w projekcji SQL `listPendingPage`. */
export interface ProposalListItem {
  id: string;
  type: ProposalType;
  origin: ProposalOrigin;
  status: ProposalStatus;
  scope: MemoryScope;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  summary: ProposalListSummary;
  /** `edited_payload IS NOT NULL` — recenzent poprawił treść (FR-Q6). */
  edited: boolean;
  /** Jak `ProposalView.stale` (display-only, bez locka). */
  stale: boolean;
  /** A1 (G10): podpowiedź „podobne do istniejących" ma CO NAJMNIEJ jedną wciąż dostępną
   * (`status='approved'`) pamięć — ta sama reguła co `available` w `ProposalView.similarMemories`,
   * żeby znacznik wiersza i blok w detalu się zgadzały. `false` także dla stanu „nie policzono". */
  hasSimilar: boolean;
  /** A2 (G5): powody zawrócenia z auto mode (zbiór zamknięty); `null` = nic nie zawrócono. */
  autoHoldReasons: AutoHoldReason[] | null;
}

/** Strona listy kolejki. `total` = `count(*)` z TYMI SAMYMI filtrami co lista (bez kursora) — licznik
 * „N z M" w dashboardzie (G4); `nextCursor` = `null` na ostatniej stronie. */
export interface ProposalListPage {
  items: ProposalListItem[];
  nextCursor: string | null;
  total: number;
}

/** Pozycja podpowiedzi „podobne do istniejących" (A1) rozwiązana po stronie serwera: `available` =
 * pamięć jest wciąż `approved`; zarchiwizowana / przycięta / usunięta po zapisie dostaje
 * `available:false`, `header:null`, `scope:null` (UI pokazuje tylko dostępne — bez błędu). */
export interface ProposalSimilarMemory {
  id: string;
  distance: number;
  available: boolean;
  header: string | null;
  scope: MemoryScope | null;
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
  /** Podpowiedź „podobne do istniejących" (A1, G1): `null` = nie policzono, `[]` = policzono, brak
   * podobnych, lista = ≤3 pozycje rosnąco po odległości. Opisuje oryginał agenta — edit-before-approve
   * jej nie zmienia (G2). */
  similarMemories: ProposalSimilarMemory[] | null;
  /** A2 (G5): powody zawrócenia z auto mode; `null` = nic nie zawrócono (też projekt bez auto mode). */
  autoHoldReasons: AutoHoldReason[] | null;
  /** A2: ISO czas auto-akceptacji (maszynowej); `null` = nie auto-zaakceptowana. */
  autoApprovedAt: string | null;
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
