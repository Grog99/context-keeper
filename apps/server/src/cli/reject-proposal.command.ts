import { Command, CommandRunner, Option } from 'nest-commander';
import { ProposalError } from '../proposals/proposals.errors';
import { ProposalsService } from '../proposals/proposals.service';

interface RejectProposalOptions {
  reason?: string;
  actor?: string;
}

@Command({
  name: 'reject-proposal',
  arguments: '<proposalId>',
  description: 'Odrzuca proposal (status=rejected) — bez mutacji pamięci, wiersz zostaje dla audytu.',
})
export class RejectProposalCommand extends CommandRunner {
  constructor(private readonly proposalsService: ProposalsService) {
    super();
  }

  async run(inputs: string[], options: RejectProposalOptions): Promise<void> {
    const proposalId = inputs[0]?.trim();
    if (!proposalId) {
      throw new Error('Podaj id proposala: reject-proposal <proposalId>');
    }

    try {
      await this.proposalsService.reject(proposalId, { actor: options.actor ?? 'human-cli', reason: options.reason });
      console.log(`[reject-proposal] ${proposalId}: OK — status=rejected`);
    } catch (err) {
      if (err instanceof ProposalError) {
        console.error(`[reject-proposal] ${proposalId}: BŁĄD (${err.code}) — ${err.message}`);
        return;
      }
      throw err;
    }
  }

  @Option({ flags: '--reason <text>', description: 'Powód odrzucenia (trafia do audytu).' })
  parseReason(val: string): string {
    return val;
  }

  @Option({ flags: '--actor <actor>', description: 'Aktor do audytu (domyślnie human-cli).' })
  parseActor(val: string): string {
    return val;
  }
}
