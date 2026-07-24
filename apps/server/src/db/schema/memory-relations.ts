import { check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { memorySource, relationType } from './enums';
import { memories } from './memories';
import { projects } from './projects';

/**
 * Krawędź grafu pamięci (roadmap v1.2, "memory-relations + 1-hop graph boost"). Typowana,
 * skierowana: `from_memory_id` → `to_memory_id`, dokładnie jeden z 3 `relation_type` (§enums.ts).
 * Kierunek niesie metadanę dla człowieka (np. "A caused_by B") — sam boost retrievalu (§graph-boost.ts)
 * czyta krawędzie SYMETRYCZNIE (oba końce się boostują), kierunek nie wpływa na ranking.
 *
 * Surogatowy `rel_…` PK (nie composite) — jednolite z resztą tabel (§konwencja `mem_…`/`prop_…`),
 * dashboard usuwa krawędź po pojedynczym opaque id. Dedup + brak duplikatów tej samej relacji
 * egzekwuje `UNIQUE(from,to,type)`; brak self-loop egzekwuje `CHECK`. Oba kierunki odczytu
 * (wychodzące z X / przychodzące do X) mają własny btree index — `listRelations` w
 * `MemoryAdminService` czyta obie strony.
 *
 * Ściśle intra-project (`project_id` NOT NULL, FK restrict): `global` jest zakazany jako endpoint
 * (agent i human path odrzucają to jako `validation_error`) — krawędź cross-project nigdy nie
 * mogłaby nic zboostować (§graph-boost.ts wymaga OBU końców w tym samym sfuzjowanym, per-project
 * zapytaniu), więc byłaby martwymi danymi. `kind=event` jako endpoint jest DOZWOLONY (świadome
 * odstępstwo od ścisłego `event`-gate'u `saveAsSupersede` — relacje są ortogonalne do `event_time`,
 * to właśnie one obsługują "ten fakt jest kontekstem dla tego zdarzenia").
 */
export const memoryRelations = pgTable(
  'memory_relations',
  {
    id: text('id').primaryKey(), // rel_…
    fromMemoryId: text('from_memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    toMemoryId: text('to_memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    type: relationType('type').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    // `source` = kto zaciągnął krawędź (§enums.ts komentarz przy `memorySource`) — `nightly` NIE
    // dotyczy relacji dziś (żaden producent), ale reużywamy istniejący enum zamiast mintować
    // węższy `agent|human`, symetrycznie z `memories.source`.
    source: memorySource('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memory_relations_from_to_type_key').on(t.fromMemoryId, t.toMemoryId, t.type),
    index('memory_relations_from_idx').on(t.fromMemoryId),
    index('memory_relations_to_idx').on(t.toMemoryId),
    index('memory_relations_project_idx').on(t.projectId),
    check('memory_relations_no_self_loop', sql`${t.fromMemoryId} <> ${t.toMemoryId}`),
  ],
);

export type MemoryRelationRow = typeof memoryRelations.$inferSelect;
export type NewMemoryRelationRow = typeof memoryRelations.$inferInsert;
