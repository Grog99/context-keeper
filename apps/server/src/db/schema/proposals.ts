import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
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
    affectedIds: text('affected_ids').array().notNull().default(sql`'{}'::text[]`),
    // Optimistic concurrency (§8bis): revision_id bazowy każdego affected_id (stan, względem którego liczono payload).
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
    index('proposals_origin_idx').on(t.origin),
    index('proposals_project_idx').on(t.projectId),
    index('proposals_content_hash_idx').on(t.contentHash),
  ],
);

export type ProposalRow = typeof proposals.$inferSelect;
export type NewProposalRow = typeof proposals.$inferInsert;
