import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { memoryKind, memoryScope, memorySource, memoryStatus } from './enums';
import { projects } from './projects';

/**
 * Dokument kanoniczny pamięci (§4). Jeden dyskryminator `kind` na tabeli.
 * Kolumna FTS `fts` (tsvector, konfiguracja `simple`) + indeks GIN dokładane RĘCZNIE w migracji
 * (generowana kolumna poza zasięgiem drizzle-kit) — patrz migrations/0000_*.sql.
 */
export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(), // mem_… — stabilny, to dostaje agent w search i podaje do get
    header: text('header').notNull(), // ≤ ~200 zn., jednolinijkowy (egzekwowane w warstwie logiki)
    body: text('body').notNull(), // markdown; limit per kind (BODY_MAX_*)
    kind: memoryKind('kind').notNull(),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    scope: memoryScope('scope').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'restrict' }), // pusty dla global
    status: memoryStatus('status').notNull().default('approved'),
    source: memorySource('source').notNull(),
    // Feed dla prune — zbierane od dnia zero, nie do odtworzenia wstecz.
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    // Optimistic-concurrency token (§8bis) — bumpowany o 1 przy KAŻDEJ zatwierdzonej mutacji
    // (update/merge/delete w ProposalsService). `proposals.base_versions` trzyma wartość, względem
    // której liczono payload; rozjazd pod locka przy approve → ProposalError('stale').
    version: integer('version').notNull().default(0),
    // Backdatable znacznik zdarzenia (roadmap v1.2, "kind=event episodic") — WYŁĄCZNIE `kind=event`
    // go wypełnia (nullable; fact/document zostają null). Osobny od `created_at` (kiedy wpis
    // POWSTAŁ w pamięci) — `event_time` to kiedy zdarzenie się WYDARZYŁO, ustawiane raz przy
    // tworzeniu (edycja po fakcie poza zakresem v1). Napędza sortowanie ekranu "Oś czasu" i
    // age-decay w rankingu retrievalu (`MemoryService.search`).
    eventTime: timestamp('event_time', { withTimezone: true }),
  },
  (t) => [
    index('memories_project_idx').on(t.projectId),
    index('memories_kind_idx').on(t.kind),
    index('memories_status_idx').on(t.status),
    index('memories_scope_idx').on(t.scope),
    index('memories_event_time_idx').on(t.eventTime),
  ],
);

export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;
