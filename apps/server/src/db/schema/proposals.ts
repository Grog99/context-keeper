import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { memoryScope, proposalOrigin, proposalStatus, proposalType } from './enums';
import { projects } from './projects';
import { projectTokens } from './project-tokens';

/** Jedna pozycja podpowiedzi „podobne do istniejących" (roadmap v1.6, A1) — id zatwierdzonej pamięci
 * i jej odległość kosinusowa (`<=>`) od nowej propozycji. */
export interface SimilarMemoryHit {
  id: string;
  distance: number;
}

/**
 * Powody, dla których bezpiecznik auto mode zawrócił zapis do kolejki (roadmap v1.6, A2, G5 + D2).
 * Zbiór zamknięty, w stałej kolejności (CHECK `proposals_auto_hold_reasons_check` i typ dashboardu go
 * lustrują). Celowo `text[]` + CHECK, nie `pgEnum` — nowa wartość enuma w migracji wpada w 55P04.
 * - `near_duplicate` — create z niepustym `similar_memories` (A1),
 * - `not_computed` — brak sygnału/wektora (provider down, budżet czasu) — zapis nie może wejść bez wektora,
 * - `human_target` — korekta treści napisanej/poprawionej przez człowieka,
 * - `daily_limit` — wyczerpany limit auto-akceptacji w oknie 24 h,
 * - `auto_failed` — bezpieczniki przeszły, ale `approve({auto})` rzuciło wyjątek (błąd po stronie serwera).
 */
export const AUTO_HOLD_REASONS = [
  'near_duplicate',
  'not_computed',
  'human_target',
  'daily_limit',
  'auto_failed',
] as const;
export type AutoHoldReason = (typeof AUTO_HOLD_REASONS)[number];

/**
 * Kolejka akceptacji — każda treściowa mutacja (§4). Kolejka to tabela, nie flaga na dokumencie
 * (merge A+B→C nie da się wyrazić flagą).
 */
export const proposals = pgTable(
  'proposals',
  {
    id: text('id').primaryKey(), // prop_…
    type: proposalType('type').notNull(),
    origin: proposalOrigin('origin').notNull(),
    status: proposalStatus('status').notNull().default('pending'),

    payload: jsonb('payload').notNull(),
    // Wersja recenzenta z edit-before-approve (FR-Q6) — `payload` zostaje nietkniętym oryginałem
    // agenta, `edited_payload` (gdy obecny) to treść, którą faktycznie materializuje `approve()`.
    editedPayload: jsonb('edited_payload'),
    affectedIds: text('affected_ids').array().notNull().default(sql`'{}'::text[]`),
    // Optimistic concurrency (§8bis): `{ [memoryId]: number }` — wartość `memories.version`, względem
    // której liczono payload, per affected id. Rozjazd pod locka przy approve → ProposalError('stale')
    // (Faza 4; patrz ProposalsService.assertNotStale). `create` ma zawsze `{}` (affectedIds=[]).
    baseVersions: jsonb('base_versions').notNull().default(sql`'{}'::jsonb`),
    // Idempotencja/dedup exact-match: hash(header+body+scope+project) (§5).
    contentHash: text('content_hash'),
    // Podpowiedź „podobne do istniejących" (roadmap v1.6, A1) — wynik detekcji prawie-duplikatów przy
    // save_memory, trzy stany: NULL = nie policzono (provider down / budżet czasu / inny typ propozycji),
    // `[]` = policzono, brak podobnych, lista = ≤3 pozycje `{id, distance}` rosnąco po odległości.
    // Wypełniana wyłącznie dla `origin='agent'` + `type='create'` + kind fact/document, JEDNORAZOWO przy
    // zapisie (UPDATE po embeddingu); edit-before-approve jej nie zmienia (opisuje oryginał agenta).
    // Bez backfillu — stare propozycje zostają NULL. Zapis `supersedes` (type='update'), eventy i
    // propozycje nocnego joba: zawsze NULL.
    similarMemories: jsonb('similar_memories').$type<SimilarMemoryHit[]>(),
    // Auto mode (roadmap v1.6, A2) — dwa wzajemnie wykluczające się stany:
    // - `auto_hold_reasons` (NOT NULL ⇒ niepusty zbiór z `AUTO_HOLD_REASONS`): projekt miał auto mode, ale
    //   bezpiecznik zawrócił ten zapis do człowieka (G5); NULL = nic nie zawrócono (też projekt bez auto
    //   mode i zapisy sprzed A2). Zapisywane best-effort, po utworzeniu propozycji.
    // - `auto_approved_at`: propozycję zatwierdziła maszyna (`approve({auto:true})`) — liczy się do limitu
    //   (c) i jest wykluczana z wykresu „wyników propozycji" (G8).
    // Brak backfillu; `confidence`/`auto_eligible` zostają nieużywane.
    autoHoldReasons: text('auto_hold_reasons').array().$type<AutoHoldReason[]>(),
    autoApprovedAt: timestamp('auto_approved_at', { withTimezone: true }),

    scope: memoryScope('scope').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    // Token zapisu `save_memory` (roadmap v1.6, A3): `ctx.tokenId` agenta, który utworzył propozycję
    // create/update — nośnik filtra „po tokenie" w cofaniu auto mode (join z `memories` po
    // `auto_approved_at`, patrz `memory/auto-mode-filters.ts`). NULL: nocny job, `create_project`, zapis
    // bez tokena w kontekście oraz stare propozycje, których audyt `proposal_created` nie niósł tokena
    // (backfill z audytu w 0020 uzupełnia resztę). FK `SET NULL` jak `search_events.token_id`.
    tokenId: text('token_id').references(() => projectTokens.id, { onDelete: 'set null' }),

    // Forward-compat v2 (anti-fatigue / sedymentacja) — miejsce już teraz, nullable.
    confidence: doublePrecision('confidence'),
    autoEligible: boolean('auto_eligible'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('proposals_status_idx').on(t.status),
    // Keyset listy kolejki (nightly-scale #5): `WHERE status = … ORDER BY created_at, id` bez sortowania.
    index('proposals_status_created_id_idx').on(t.status, t.createdAt, t.id),
    index('proposals_origin_idx').on(t.origin),
    index('proposals_project_idx').on(t.projectId),
    index('proposals_content_hash_idx').on(t.contentHash),
    // Licznik limitu (c) i filtr G8: auto-akceptacje projektu w oknie 24 h.
    index('proposals_project_auto_approved_idx')
      .on(t.projectId, t.autoApprovedAt)
      .where(sql`${t.autoApprovedAt} IS NOT NULL`),
    // Statystyka powodów zawrócenia (A4): `auto_hold_reasons IS NOT NULL` w zakresie `created_at` per projekt.
    index('proposals_project_auto_held_idx')
      .on(t.projectId, t.createdAt)
      .where(sql`${t.autoHoldReasons} IS NOT NULL`),
    check(
      'proposals_auto_hold_reasons_check',
      sql`${t.autoHoldReasons} IS NULL OR (cardinality(${t.autoHoldReasons}) > 0 AND ${t.autoHoldReasons} <@ ARRAY['near_duplicate','not_computed','human_target','daily_limit','auto_failed']::text[])`,
    ),
    check('proposals_auto_state_check', sql`${t.autoApprovedAt} IS NULL OR ${t.autoHoldReasons} IS NULL`),
    // Unikalność slugu wśród OCZEKUJĄCYCH propozycji `create_project` (roadmap v1.5, ticket #14).
    // Predykat celowo NIE używa `type = 'create_project'`: drizzle stosuje wszystkie oczekujące
    // migracje w JEDNEJ transakcji, a Postgres zabrania użycia nowej wartości enuma w transakcji,
    // która ją dodała (55P04 "unsafe use of new value") — indeks z literałem enuma przechodzi na
    // świeżej bazie (enum tworzony w tej samej transakcji), ale wywala realny upgrade z 0012.
    // `type::text = …` odpada (`enum_out` jest STABLE, nie IMMUTABLE — niedozwolone w predykacie
    // indeksu). Niezmiennik: WYŁĄCZNIE payload `create_project` ma klucz `slug` na najwyższym
    // poziomie (payloady pamięci — create/update/merge/delete — go nie mają). Przyszły typ
    // propozycji z kluczem `slug` wszedłby po cichu do tego indeksu. Chroni to
    // `proposals-create-project.migration.spec.ts` (upgrade 0012 → 0013).
    uniqueIndex('proposals_create_project_slug_pending_key')
      .on(sql`(${t.payload} ->> 'slug')`)
      .where(sql`${t.status} = 'pending' AND (${t.payload} ->> 'slug') IS NOT NULL`),
  ],
);

export type ProposalRow = typeof proposals.$inferSelect;
export type NewProposalRow = typeof proposals.$inferInsert;
