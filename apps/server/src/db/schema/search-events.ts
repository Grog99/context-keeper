import { boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects';

/**
 * Append-only instrumentacja `search_memory` (roadmap v1.1, "Pomiary"). Jeden tani INSERT per
 * wywołanie `MemoryService.search()` — WYŁĄCZNIE ścieżka MCP (`get_memory` nie jest instrumentowane,
 * ma już `access_count`). Świadomie BEZ treści zapytania i BEZ hasha zapytania (prywatność, decyzja
 * planu §5(a)) — tylko liczba wyników i flaga degradacji.
 *
 * Osobna tabela od `audit_log` (nie event tam) — `audit_log` dokumentuje "odczyty nie logowane
 * per-event"; wysokoczęstotliwościowe zdarzenia search zalałyby ekran Audytu i złamałyby ten
 * invariant. `search_events` ma własną retencję (`SEARCH_EVENTS_RETENTION_DAYS`), pruned nocnym jobem.
 *
 * `degraded` = zapytanie policzone BEZ ramienia wektorowego (`qvec === null` w `MemoryService.search`,
 * provider embeddingów down/timeout) — wynik 0 przy degradacji nie znaczy "pamięć nie ma treści",
 * więc jest wyłączony z sygnału zero-result rate na ekranie Pomiary.
 */
export const searchEvents = pgTable(
  'search_events',
  {
    id: text('id').primaryKey(), // sev_…
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    resultCount: integer('result_count').notNull(),
    degraded: boolean('degraded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('search_events_project_created_idx').on(t.projectId, t.createdAt),
    index('search_events_created_idx').on(t.createdAt),
  ],
);

export type SearchEventRow = typeof searchEvents.$inferSelect;
export type NewSearchEventRow = typeof searchEvents.$inferInsert;
