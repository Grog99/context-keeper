import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { auditEventType } from './enums';

/**
 * Append-only audit (§4, NFR-2). Każdy zapis, który wszedł do pamięci, ma ślad kto go wepchnął.
 * Metadane sekretów/purge trzymane BEZ materiału sekretu (§10).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(), // evt_…
    eventType: auditEventType('event_type').notNull(),
    actor: text('actor').notNull(), // token+project_id albo "human-dashboard"
    affectedIds: text('affected_ids').array().notNull().default(sql`'{}'::text[]`),
    revisionId: text('revision_id'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_event_type_idx').on(t.eventType),
    index('audit_created_at_idx').on(t.createdAt),
    index('audit_actor_idx').on(t.actor),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
