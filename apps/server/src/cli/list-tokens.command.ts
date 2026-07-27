import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';
import { effectiveTokenStatus } from '../projects/token-status';

/** Tokeny jednego projektu (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") — punkt
 * wejścia do znalezienia `<tokenId>` dla `rotate-token`/`revoke-token`. Format tab-separated jak
 * `list-projects` (spójność narzędziowa, choć bez znanego zewnętrznego parsera jak `install.sh`). */
@Command({
  name: 'list-tokens',
  arguments: '<projectId>',
  description: 'Wypisuje tokeny projektu (id, status, etykieta, wygasa) — bez wartości tokena.',
})
export class ListTokensCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const projectId = inputs[0]?.trim();
    if (!projectId) {
      throw new Error('Podaj id projektu: list-tokens <projectId>');
    }
    const rows = await this.projects.listTokens(projectId);
    if (rows.length === 0) {
      console.log(`Brak tokenów dla projektu ${projectId}.`);
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
