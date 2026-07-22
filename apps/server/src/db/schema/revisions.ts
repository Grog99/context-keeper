import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { revisionAction } from './enums';
import { memories } from './memories';

/**
 * Lekkie snapshoty przy każdej zatwierdzonej zmianie (§4) — „co tu było wcześniej".
 * Pełny snapshot dla `fact`; dla dużych `document` rozważyć diff (knob). Supersession linkowana tutaj.
 */
export const revisions = pgTable(
  'revisions',
  {
    id: text('id').primaryKey(), // rev_…
    memoryId: text('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    action: revisionAction('action').notNull(),
    actor: text('actor').notNull(), // token+project_id albo "human-dashboard"
    snapshot: jsonb('snapshot'),
    supersedes: text('supersedes'), // id pamięci zastępowanej (supersession)
    supersededBy: text('superseded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('revisions_memory_idx').on(t.memoryId)],
);

export type RevisionRow = typeof revisions.$inferSelect;
export type NewRevisionRow = typeof revisions.$inferInsert;
