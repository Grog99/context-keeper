import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projectTokenStatus } from './enums';

/**
 * Projekty i ich bearer tokeny (§4, §10).
 * `token_hash` = SHA-256 tokena `ck_…` (nigdy plaintext). Lookup token→project = jeden trafiony indeks.
 */
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(), // proj_…
    name: text('name').notNull(),
    tokenHash: text('token_hash'), // null gdy token jeszcze nie wygenerowany
    tokenStatus: projectTokenStatus('token_status').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    tokenRotatedAt: timestamp('token_rotated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('projects_token_hash_key').on(t.tokenHash),
    index('projects_name_idx').on(t.name),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
