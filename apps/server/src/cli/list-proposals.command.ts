import { Command, CommandRunner, Option } from 'nest-commander';
import type { ProposalOrigin, ProposalStatus } from '../db/schema/enums';
import { ProposalsService } from '../proposals/proposals.service';

interface ListProposalsOptions {
  status?: string;
  origin?: string;
  project?: string;
}

const VALID_STATUSES: ProposalStatus[] = ['pending', 'approved', 'rejected', 'withdrawn'];
const VALID_ORIGINS: ProposalOrigin[] = ['agent', 'human', 'nightly'];

@Command({
  name: 'list-proposals',
  description: 'Wypisuje proposale kolejki akceptacji (domyślnie --status pending) + badge STALE.',
})
export class ListProposalsCommand extends CommandRunner {
  constructor(private readonly proposalsService: ProposalsService) {
    super();
  }

  async run(_inputs: string[], options: ListProposalsOptions): Promise<void> {
    const status = this.parseEnum(options.status, VALID_STATUSES, '--status');
    const origin = this.parseEnum(options.origin, VALID_ORIGINS, '--origin');

    const rows = await this.proposalsService.listPending({ status, origin, projectId: options.project });
    if (rows.length === 0) {
      console.log('Brak proposali dla podanych filtrów.');
      return;
    }

    console.log('ID\tTYPE\tORIGIN\tSCOPE\tPROJECT\tCREATED_AT\tSTALE');
    for (const p of rows) {
      const staleBadge = p.stale ? `STALE(${p.staleIds.join(',')})` : '';
      console.log(
        `${p.id}\t${p.type}\t${p.origin}\t${p.scope}\t${p.projectId ?? '-'}\t${p.createdAt}\t${staleBadge}`,
      );
    }
  }

  private parseEnum<T extends string>(val: string | undefined, allowed: readonly T[], flag: string): T | undefined {
    if (val === undefined) return undefined;
    if (!allowed.includes(val as T)) {
      throw new Error(`${flag} musi być jedną z: ${allowed.join(', ')}`);
    }
    return val as T;
  }

  @Option({
    flags: '--status <status>',
    description: 'pending | approved | rejected | withdrawn (domyślnie pending)',
  })
  parseStatus(val: string): string {
    return val;
  }

  @Option({ flags: '--origin <origin>', description: 'agent | human | nightly' })
  parseOrigin(val: string): string {
    return val;
  }

  @Option({ flags: '--project <projectId>', description: 'Ogranicz do jednego projektu' })
  parseProject(val: string): string {
    return val;
  }
}
