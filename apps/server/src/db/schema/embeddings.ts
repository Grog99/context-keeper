import { index, integer, pgTable, text, vector } from 'drizzle-orm/pg-core';
import { memories } from './memories';
import { proposals } from './proposals';

// Wymiar wektora = preset domyślny `multilingual`/bge-m3 (1024).
// Zmiana presetu pod istniejącymi danymi = migracja `reembed` (Faza 3), NIE ręczny ALTER.
export const EMBEDDING_DIM = 1024;

/**
 * Embeddingi autorytatywne (jeden-do-wielu — chunking). Mały dokument = jeden chunk.
 * `embedding_model` przy każdym wektorze → filtr aktywnego modelu w search (§6) + gotowość na re-embed.
 * Indeks HNSW (vector_cosine_ops) dokładany RĘCZNIE w migracji (operator class — drizzle-kit #5792).
 */
export const embeddings = pgTable(
  'embeddings',
  {
    id: text('id').primaryKey(), // emb_…
    memoryId: text('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull().default(0),
    chunkText: text('chunk_text').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    vector: vector('vector', { dimensions: EMBEDDING_DIM }),
  },
  (t) => [
    index('embeddings_memory_idx').on(t.memoryId),
    index('embeddings_model_idx').on(t.embeddingModel),
  ],
);

/**
 * Wektory policzone przy `save` (dla dedup), zanim proposal zostanie zatwierdzony (§4).
 * MOŻE być puste (provider down przy save) → autorytatywny embedding liczony przy akceptacji.
 */
export const stagingEmbeddings = pgTable(
  'staging_embeddings',
  {
    id: text('id').primaryKey(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull().default(0),
    chunkText: text('chunk_text').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    vector: vector('vector', { dimensions: EMBEDDING_DIM }),
  },
  (t) => [index('staging_embeddings_proposal_idx').on(t.proposalId)],
);

export type EmbeddingRow = typeof embeddings.$inferSelect;
export type StagingEmbeddingRow = typeof stagingEmbeddings.$inferSelect;
