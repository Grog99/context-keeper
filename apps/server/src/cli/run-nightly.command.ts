import { Command, CommandRunner, Option } from 'nest-commander';
import { NightlyService } from '../nightly/nightly.service';

interface RunNightlyOptions {
  actor?: string;
}

const DEFAULT_ACTOR = 'nightly';

/**
 * `run-nightly` (plan Fazy 6 §2 "run-nightly.command.ts") — jedyny sposób odpalenia nocnego joba
 * w v1 (poza zakresem: OS/container-level scheduling, Faza 8). Ręczny trigger albo cel wywołania
 * przez zewnętrzny scheduler (`NIGHTLY_CRON`/`NIGHTLY_TZ` w env to KONTRAKT dla takiego schedulera,
 * ta komenda go nie czyta — sama uruchamia się natychmiast po wywołaniu).
 */
@Command({
  name: 'run-nightly',
  description: 'Uruchamia nocny job (dedup/merge + prune proposer) — jednorazowy, ręczny przebieg.',
})
export class RunNightlyCommand extends CommandRunner {
  constructor(private readonly nightlyService: NightlyService) {
    super();
  }

  async run(_inputs: string[], options: RunNightlyOptions): Promise<void> {
    // UWAGA: nest-commander@3.20.1 połyka błąd rzucony z run() (patrz reembed.command.ts) — łapiemy
    // jawnie i drukujemy czytelnie zamiast liczyć na propagację do niezerowego exit code.
    try {
      const result = await this.nightlyService.run({ actor: options.actor ?? DEFAULT_ACTOR });
      const c = result.counters;
      const summary =
        `[run-nightly] status=${result.status} durationMs=${result.durationMs} ` +
        `created=${c.created} withdrawn=${c.withdrawn} skipped=${c.skippedAsDup} ` +
        `merge=${c.mergeProposed} prune=${c.pruneProposed} ` +
        `skippedPoliteness=${c.skippedPoliteness} skippedCap=${c.skippedCap}`;
      if (result.status === 'success') {
        console.log(summary);
      } else {
        console.warn(summary);
      }
    } catch (err) {
      console.error(`[run-nightly] BŁĄD — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  @Option({ flags: '--actor <actor>', description: `Aktor do audytu/proposali (domyślnie ${DEFAULT_ACTOR}).` })
  parseActor(val: string): string {
    return val;
  }
}
