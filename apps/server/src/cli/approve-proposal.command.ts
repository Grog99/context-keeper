import { Command, CommandRunner, Option } from 'nest-commander';
import { ProposalError } from '../proposals/proposals.errors';
import { ProposalsService } from '../proposals/proposals.service';

interface ApproveProposalOptions {
  supersedes?: string;
  expectedSupersedeVersion?: string;
  actor?: string;
}

@Command({
  name: 'approve-proposal',
  arguments: '<proposalId>',
  description: 'Zatwierdza proposal — materializuje/aktualizuje/scala/archiwizuje pamięć transakcyjnie.',
})
export class ApproveProposalCommand extends CommandRunner {
  constructor(private readonly proposalsService: ProposalsService) {
    super();
  }

  async run(inputs: string[], options: ApproveProposalOptions): Promise<void> {
    const proposalId = inputs[0]?.trim();
    if (!proposalId) {
      throw new Error('Podaj id proposala: approve-proposal <proposalId>');
    }

    let expectedSupersedeVersion: number | undefined;
    if (options.expectedSupersedeVersion !== undefined) {
      expectedSupersedeVersion = Number.parseInt(options.expectedSupersedeVersion, 10);
      if (!Number.isFinite(expectedSupersedeVersion)) {
        throw new Error('--expected-supersede-version musi być liczbą całkowitą');
      }
    }

    // UWAGA: nest-commander@3.20.1 połyka błąd rzucony z run() (patrz reembed.command.ts) — dlatego
    // ProposalError jest łapany tutaj jawnie i drukowany czytelnie, zamiast liczyć na propagację.
    try {
      const result = await this.proposalsService.approve(proposalId, {
        actor: options.actor ?? 'human-cli',
        supersedes: options.supersedes,
        expectedSupersedeVersion,
      });
      console.log(
        `[approve-proposal] ${proposalId}: OK — materializedId=${result.materializedId ?? '-'}, ` +
          `archivedIds=[${result.archivedIds.join(', ')}], embedding=${result.embedding}`,
      );
    } catch (err) {
      if (err instanceof ProposalError) {
        const staleSuffix = err.staleIds ? ` staleIds=[${err.staleIds.join(', ')}]` : '';
        console.error(`[approve-proposal] ${proposalId}: BŁĄD (${err.code}) — ${err.message}${staleSuffix}`);
        return;
      }
      throw err;
    }
  }

  @Option({
    flags: '--supersedes <memoryId>',
    description: 'Id pamięci zastępowanej supersession (FR-Q8, tylko dla proposali type=create).',
  })
  parseSupersedes(val: string): string {
    return val;
  }

  @Option({
    flags: '--expected-supersede-version <n>',
    description: 'Opcjonalny stale-guard dla --supersedes.',
  })
  parseExpectedSupersedeVersion(val: string): string {
    return val;
  }

  @Option({ flags: '--actor <actor>', description: 'Aktor do audytu/rewizji (domyślnie human-cli).' })
  parseActor(val: string): string {
    return val;
  }
}
