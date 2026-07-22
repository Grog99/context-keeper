import { Command, CommandRunner, Option } from 'nest-commander';
import { PurgeError } from '../purge/purge.errors';
import { PurgeService } from '../purge/purge.service';

interface PurgeOptionsCli {
  reason?: string;
  confirm?: boolean;
  actor?: string;
}

/**
 * `purge` (FR-S3, §10 tech-stack) — hard-purge CLI, NIEODWRACALNE. Jedyny sposób wywołania w v1
 * (nie MCP, nie dashboard — przycisk tam to v1.1). Jedno wywołanie: bez `--confirm` to dry-run
 * (podgląd skali, zero mutacji); z `--confirm` wykonuje. `--reason` zawsze wymagany — to jedyny
 * zapis "dlaczego" dla tej operacji, trafia do `audit_log.purge_tombstone`.
 */
@Command({
  name: 'purge',
  arguments: '<memoryId>',
  description:
    'Hard-purge (NIEODWRACALNE): wymazuje treść pamięci ze wszystkich content-bearing tabel + audit ' +
    'purge_tombstone. Bez --confirm = dry-run. Wymaga --reason.',
})
export class PurgeCommand extends CommandRunner {
  constructor(private readonly purge: PurgeService) {
    super();
  }

  async run(inputs: string[], options: PurgeOptionsCli): Promise<void> {
    const memoryId = inputs[0]?.trim();
    if (!memoryId) {
      throw new Error('Podaj id pamięci: purge <memoryId> --reason "..." --confirm');
    }
    const reason = options.reason?.trim();
    if (!reason) {
      throw new Error(
        '--reason jest wymagany (trafia do audit_log.purge_tombstone) — np. ' +
          '--reason "AWS access key wyciekł w body, rotacja wykonana"',
      );
    }

    // UWAGA: nest-commander@3.20.1 połyka błąd rzucony z run() (patrz reembed.command.ts) — łapiemy
    // PurgeError jawnie i drukujemy czytelnie, zamiast liczyć na propagację do exit code.
    try {
      const preview = await this.purge.preview(memoryId);
      console.log(
        `[purge] ${memoryId}: status=${preview.status}, header="${preview.header}" — ` +
          `embeddings=${preview.embeddingsCount}, powiązane proposale=${preview.relatedProposalsCount}, ` +
          `rewizje z treścią=${preview.revisionsWithContentCount}`,
      );

      if (!options.confirm) {
        console.log(
          '[purge] DRY-RUN (brak --confirm) — nic nie zostało zmienione. Powtórz z --confirm, żeby ' +
            'wykonać NIEODWRACALNE wymazanie treści.',
        );
        return;
      }

      const result = await this.purge.purge(memoryId, { reason, actor: options.actor ?? 'human-cli' });
      console.log(
        `[purge] ${memoryId}: OK — embeddingsDeleted=${result.embeddingsDeleted}, ` +
          `stagingEmbeddingsDeleted=${result.stagingEmbeddingsDeleted}, ` +
          `proposalsRedacted=${result.proposalsRedacted}, revisionsRedacted=${result.revisionsRedacted}`,
      );
    } catch (err) {
      if (err instanceof PurgeError) {
        console.error(`[purge] ${memoryId}: BŁĄD (${err.code}) — ${err.message}`);
        return;
      }
      throw err;
    }
  }

  @Option({ flags: '--reason <text>', description: 'Powód purge (WYMAGANY, trafia do audit_log).' })
  parseReason(val: string): string {
    return val;
  }

  @Option({ flags: '--confirm', description: 'Wykonaj naprawdę (bez tej flagi: tylko podgląd/dry-run).' })
  parseConfirm(): boolean {
    return true;
  }

  @Option({ flags: '--actor <actor>', description: 'Aktor do audytu (domyślnie human-cli).' })
  parseActor(val: string): string {
    return val;
  }
}
