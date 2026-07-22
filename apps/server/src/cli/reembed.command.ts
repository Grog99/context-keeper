import { Inject } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { Command, CommandRunner, Option } from 'nest-commander';
import { generateId, ID_PREFIX } from '../common/ids';
import { DB, type Database } from '../db/db.tokens';
import { embeddings, memories } from '../db/schema';
import { EmbeddingService } from '../embeddings/embedding.service';

interface ReembedOptions {
  project?: string;
  force?: boolean;
  batch?: string;
}

const DEFAULT_BATCH_SIZE = 50;

/**
 * `reembed` (§7/§9 tech-stack; Faza 3 plan §5 pkt 3): blocking CLI, NIE background job. Przelicza
 * authoritative `embeddings` dla approved memories aktywnym providerem/modelem. Dwa powody
 * uruchomienia: (a) backfill pamięci sprzed Fazy 3 (bez wektora w ogóle), (b) po zmianie
 * presetu/modelu (stare wiersze innego modelu trzeba zastąpić). Dopóki trwa przebieg, ramię
 * wektorowe w search i tak filtruje po aktywnym modelu (FR-R5) — nietknięte jeszcze memories
 * po prostu nie biorą udziału w ramieniu wektorowym, bez przerwy w dostępności FTS.
 *
 * Idempotentne: bez `--force` pomija memory, które ma już wiersz aktywnego modelu.
 */
@Command({
  name: 'reembed',
  description: 'Przelicza authoritative embeddings dla approved memories aktywnym providerem/modelem.',
})
export class ReembedCommand extends CommandRunner {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly embedding: EmbeddingService,
  ) {
    super();
  }

  async run(_inputs: string[], options: ReembedOptions): Promise<void> {
    const batchSize = options.batch ? Number.parseInt(options.batch, 10) : DEFAULT_BATCH_SIZE;
    if (!Number.isFinite(batchSize) || batchSize <= 0) {
      throw new Error('--batch musi być dodatnią liczbą całkowitą');
    }
    const activeModel = this.embedding.model;

    const conditions = [eq(memories.status, 'approved')];
    if (options.project) {
      conditions.push(eq(memories.projectId, options.project));
    }

    let seen = 0;
    let embedded = 0;
    let skipped = 0;
    let failed = 0;

    // Paginacja przez --batch (ORDER BY id, LIMIT/OFFSET) zamiast jednego SELECT-a wszystkich
    // approved memories naraz — na skali "setki tysięcy" (§3 tech-stack) trzyma pamięć procesu
    // pod kontrolą. Mutacje `embeddings` w pętli nie ruszają `memories`, więc paginacja zostaje
    // stabilna między batchami.
    for (let offset = 0; ; offset += batchSize) {
      const batch = await this.db
        .select()
        .from(memories)
        .where(and(...conditions))
        .orderBy(asc(memories.id))
        .limit(batchSize)
        .offset(offset);
      if (batch.length === 0) break;
      seen += batch.length;

      for (const row of batch) {
        if (!options.force) {
          const [existing] = await this.db
            .select({ id: embeddings.id })
            .from(embeddings)
            .where(and(eq(embeddings.memoryId, row.id), eq(embeddings.embeddingModel, activeModel)))
            .limit(1);
          if (existing) {
            skipped++;
            continue;
          }
        }

        try {
          const result = await this.embedding.embedChunks(row.kind, row.header, row.body, row.tags);
          await this.db.transaction(async (tx) => {
            // Usuwa WSZYSTKIE dotychczasowe wiersze dla tej memory (stary model I ewentualne stare
            // wiersze aktywnego modelu pod --force), potem wstawia świeży komplet — bez okna, w
            // którym memory ma zdublowane/częściowe chunki.
            await tx.delete(embeddings).where(eq(embeddings.memoryId, row.id));
            await tx.insert(embeddings).values(
              result.chunks.map((c) => ({
                id: generateId(ID_PREFIX.embedding),
                memoryId: row.id,
                chunkIndex: c.index,
                chunkText: c.text,
                embeddingModel: result.model,
                vector: c.vector,
              })),
            );
          });
          embedded++;
          console.log(`[reembed] ${row.id}: ${result.chunks.length} chunk(i), model=${result.model}`);
        } catch (err) {
          failed++;
          console.error(`[reembed] ${row.id}: BŁĄD — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (seen === 0) {
      console.log('[reembed] Brak approved memories do przeliczenia (sprawdź --project).');
      return;
    }

    const summary =
      `[reembed] gotowe: ${embedded} przeliczonych, ${skipped} pominiętych (już aktualne), ` +
      `${failed} błędów (z ${seen} approved memories, model=${activeModel}).`;
    // UWAGA (odkryte przy weryfikacji): nest-commander@3.20.1 połyka błąd rzucony z `run()` —
    // nie propaguje go do `CommandFactory.run()` ani nie ustawia `process.exitCode` (zweryfikowane
    // izolowanym repro; ten sam efekt ma już istniejący `seed-memory.command.ts`). `cli.ts` i tak
    // woła `process.exit(0)` po sukcesie, więc rzucanie stąd NIE dałoby niezerowego exit code —
    // zostaje więc czytelny log; niezerowy exit code dla `reembed` to pre-existing ograniczenie
    // frameworka CLI, poza zakresem tej zmiany (dotyczy wszystkich komend, nie tylko tej).
    if (failed > 0) {
      console.error(summary);
    } else {
      console.log(summary);
    }
  }

  @Option({
    flags: '--project <projectId>',
    description: 'Ogranicz do jednego projektu (domyślnie wszystkie approved memories).',
  })
  parseProject(val: string): string {
    return val;
  }

  @Option({
    flags: '--force',
    description: 'Przelicz nawet gdy wiersze aktywnego modelu już istnieją.',
  })
  parseForce(): boolean {
    return true;
  }

  @Option({
    flags: '--batch <n>',
    description: `Rozmiar batcha zapisu (domyślnie ${DEFAULT_BATCH_SIZE}).`,
  })
  parseBatch(val: string): string {
    return val;
  }
}
