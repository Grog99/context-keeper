import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Projekty (§4, §10). Bearer tokeny żyją w osobnej tabeli `project_tokens` (roadmap v1.3, "Wiele
 * tokenów per projekt + graceful rotation" — 1 projekt → N tokenów, patrz `project-tokens.ts`)
 * — `projects` sam już nie niesie żadnej tokenowej kolumny (dawniej `token_hash`/`token_status`/
 * `token_rotated_at`), żeby uniknąć dwóch źródeł prawdy o tym, co jest "aktywnym" tokenem.
 */
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(), // proj_…
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Per-projektowy toggle (roadmap v1.2, "kind=event episodic") — czy `event` dokłada się do
    // domyślnego zestawu `kind` w `search_memory` gdy agent nie podał `kind` jawnie (agent zawsze
    // może poprosić o `kind=event` wprost, niezależnie od tego pola). Default `false` zachowuje
    // dzisiejsze zachowanie (opt-in-only) dla wszystkich istniejących projektów bez backfillu.
    includeEventsInDefaultSearch: boolean('include_events_in_default_search').notNull().default(false),
  },
  (t) => [index('projects_name_idx').on(t.name)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
