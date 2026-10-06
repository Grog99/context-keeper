import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';
import { effectiveTokenStatus } from '../projects/token-status';

/** Tokeny konta (roadmap v1.5) — punkt wejścia do znalezienia `<tokenId>` dla `rotate-token`/
 * `revoke-token`. Format jak `list-tokens` (tab-separated, bez wartości tokena). */
@Command({
  name: 'list-account-tokens',
  description: 'Wypisuje tokeny konta (id, status, etykieta, wygasa) — bez wartości tokena.',
})
export class ListAccountTokensCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(): Promise<void> {
    const rows = await this.projects.listAccountTokens();
    if (rows.length === 0) {
      console.log('Brak tokenów konta. Utwórz: create-account-token <label>');
      return;
    }
    const now = new Date();
    console.log('TOKEN_ID\tSTATUS\tETYKIETA\tWYGASA');
    for (const row of rows) {
      const status = effectiveTokenStatus(row, now);
      const expiresAt = row.expiresAt ? row.expiresAt.toISOString() : '—';
      console.log(`${row.id}\t${status}\t${row.label}\t${expiresAt}`);
    }
  }
}
