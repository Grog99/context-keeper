import { sql } from 'drizzle-orm';
import {
  boolean,
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

    scope: memoryScope('scope').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'restrict' }),

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
