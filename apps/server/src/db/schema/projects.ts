import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** Domyślny dzienny limit auto-akceptacji projektu (roadmap v1.6, A2, G4) — wartość wyjściowa, do korekty po pomiarach A4. */
export const AUTO_MODE_DEFAULT_DAILY_LIMIT = 50;
/** Górna granica limitu (lustro `llm_settings.call_cap`); dolna to 1. */
export const AUTO_MODE_MAX_DAILY_LIMIT = 10000;

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
    // Auto mode per projekt (roadmap v1.6, A2) — gdy `true`, zapisy agenta (`create`/`update` z
    // `save_memory`), które przejdą bezpieczniki (`memory/auto-mode-guards.ts`), zatwierdza maszyna przez
    // `ProposalsService.approve`. Default `false` = human-gate bez zmian. Zmienia go wyłącznie człowiek
    // (PATCH /api/projects/:id za SessionGuard+CsrfGuard); żadne narzędzie MCP go nie czyta ani nie zmienia.
    autoMode: boolean('auto_mode').notNull().default(false),
    // Limit (c) bezpiecznika: ile auto-akceptacji projekt może zrobić w oknie kroczącym 24 h (G4, #8).
    autoModeDailyLimit: integer('auto_mode_daily_limit').notNull().default(AUTO_MODE_DEFAULT_DAILY_LIMIT),
  },
  (t) => [
    index('projects_name_idx').on(t.name),
    uniqueIndex('projects_slug_key').on(t.slug),
    check(
      'projects_slug_format_check',
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t.slug}) BETWEEN 2 AND 48`,
    ),
    check(
      'projects_auto_mode_daily_limit_check',
      sql`${t.autoModeDailyLimit} BETWEEN 1 AND ${sql.raw(String(AUTO_MODE_MAX_DAILY_LIMIT))}`,
    ),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
