import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Projekty (§4, §10). Bearer tokeny żyją w osobnej tabeli `project_tokens` (roadmap v1.3, "Wiele
 * tokenów per projekt + graceful rotation" — 1 projekt → N tokenów, patrz `project-tokens.ts`)
 * — `projects` sam już nie niesie żadnej tokenowej kolumny (dawniej `token_hash`/`token_status`/
 * `token_rotated_at`), żeby uniknąć dwóch źródeł prawdy o tym, co jest "aktywnym" tokenem.
 *
 * `slug` (roadmap v1.5, "Wskazanie projektu nagłówkiem") — stabilny identyfikator z commitowanego
 * `.mcp.json` (`X-Context-Keeper-Project: <slug>`). Format `^[a-z0-9]+(-[a-z0-9]+)*$`, 2–48 znaków,
 * unikalny; egzekwowany indeksem + CHECK (te same reguły co `projects/slug.ts`). Backfill
 * istniejących projektów z `name` robi migracja 0012.
 */
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(), // proj_…
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Per-projektowy toggle (roadmap v1.2, "kind=event episodic") — czy `event` dokłada się do
    // domyślnego zestawu `kind` w `search_memory` gdy agent nie podał `kind` jawnie (agent zawsze
    // może poprosić o `kind=event` wprost, niezależnie od tego pola). Default `false` zachowuje
    // dzisiejsze zachowanie (opt-in-only) dla wszystkich istniejących projektów bez backfillu.
    includeEventsInDefaultSearch: boolean('include_events_in_default_search').notNull().default(false),
  },
  (t) => [
    index('projects_name_idx').on(t.name),
    uniqueIndex('projects_slug_key').on(t.slug),
    check(
      'projects_slug_format_check',
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t.slug}) BETWEEN 2 AND 48`,
    ),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
