import { Command, CommandRunner, Option } from 'nest-commander';
import { AuditService } from '../audit/audit.service';

interface RecordBackupOptions {
  status?: string;
  dump?: string;
  size?: string;
  offsite?: string;
  error?: string;
}

const ACTOR = 'backup';

/**
 * `record-backup` — wołane z `infra/backup.sh` (`docker compose run --rm app pnpm cli
 * record-backup ...`) po każdym przebiegu backupu, sukces czy porażka. Jeden event
 * `backup_completed`, różnicowany przez `metadata.status` (dokładnie wzorzec `nightly_run`
 * w `nightly.service.ts`) — bez osobnej wartości enuma na porażkę.
 */
@Command({
  name: 'record-backup',
  description: 'Zapisuje wpis audytowy (backup_completed) dla przebiegu infra/backup.sh.',
})
export class RecordBackupCommand extends CommandRunner {
  constructor(private readonly audit: AuditService) {
    super();
  }

  async run(_inputs: string[], options: RecordBackupOptions): Promise<void> {
    const status = options.status;
    if (status !== 'ok' && status !== 'failed') {
      console.error(`[record-backup] BŁĄD — --status musi być 'ok' albo 'failed' (dostałem: ${options.status})`);
      return;
    }
    // UWAGA: nest-commander@3.20.1 połyka błąd rzucony z run() (patrz run-nightly.command.ts) —
    // łapiemy jawnie i drukujemy czytelnie zamiast liczyć na propagację do niezerowego exit code.
    try {
      await this.audit.log({
        eventType: 'backup_completed',
        actor: ACTOR,
        metadata: {
          status,
          ...(options.dump ? { dump: options.dump } : {}),
          ...(options.size ? { sizeBytes: Number(options.size) } : {}),
          ...(options.offsite ? { offsite: options.offsite } : {}),
          ...(options.error ? { error: options.error } : {}),
        },
      });
      console.log(`[record-backup] status=${status} zapisano do audit_log`);
    } catch (err) {
      console.error(`[record-backup] BŁĄD — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  @Option({ flags: '--status <status>', description: "Wynik backupu: 'ok' albo 'failed'." })
  parseStatus(val: string): string {
    return val;
  }

  @Option({ flags: '--dump <path>', description: 'Ścieżka do pliku dumpa (jeśli powstał).' })
  parseDump(val: string): string {
    return val;
  }

  @Option({ flags: '--size <bytes>', description: 'Rozmiar dumpa w bajtach.' })
  parseSize(val: string): string {
    return val;
  }

  @Option({ flags: '--offsite <mode>', description: "Wynik offsite: 'skipped' | 'custom' | 'rclone:<remote>'." })
  parseOffsite(val: string): string {
    return val;
  }

  @Option({ flags: '--error <message>', description: 'Komunikat błędu przy --status=failed.' })
  parseError(val: string): string {
    return val;
  }
}
