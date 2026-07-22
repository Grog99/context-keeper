import { Command, CommandRunner, Option } from 'nest-commander';
import { ProposalError } from '../proposals/proposals.errors';
import { ProposalsService } from '../proposals/proposals.service';

interface EditProposalOptions {
  header?: string;
  body?: string;
  tags?: string;
  actor?: string;
}

@Command({
  name: 'edit-proposal',
  arguments: '<proposalId>',
  description:
    'Edit-before-approve (FR-Q6): zapisuje wersję recenzenta do edited_payload, status zostaje pending.',
})
export class EditProposalCommand extends CommandRunner {
  constructor(private readonly proposalsService: ProposalsService) {
    super();
  }

  async run(inputs: string[], options: EditProposalOptions): Promise<void> {
    const proposalId = inputs[0]?.trim();
    if (!proposalId) {
      throw new Error('Podaj id proposala: edit-proposal <proposalId>');
    }
    if (options.header === undefined && options.body === undefined && options.tags === undefined) {
      throw new Error('Podaj co najmniej jedno: --header / --body / --tags');
    }
    const tags = options.tags
      ? options.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    try {
      const result = await this.proposalsService.edit(
        proposalId,
        { header: options.header, body: options.body, tags },
        { actor: options.actor ?? 'human-cli' },
      );
      console.log(`[edit-proposal] ${proposalId}: OK — edited_payload zapisany, status wciąż pending`);
      for (const warning of result.warnings) {
        console.warn(`[edit-proposal] ${proposalId}: UWAGA — ${warning}`);
      }
    } catch (err) {
      if (err instanceof ProposalError) {
        console.error(`[edit-proposal] ${proposalId}: BŁĄD (${err.code}) — ${err.message}`);
        return;
      }
      throw err;
    }
  }

  @Option({ flags: '--header <header>', description: 'Nowy nagłówek (≤200 zn.)' })
  parseHeader(val: string): string {
    return val;
  }

  @Option({ flags: '--body <body>', description: 'Nowa treść (markdown)' })
  parseBody(val: string): string {
    return val;
  }

  @Option({ flags: '--tags <tags>', description: 'Lista tagów oddzielonych przecinkiem' })
  parseTags(val: string): string {
    return val;
  }

  @Option({ flags: '--actor <actor>', description: 'Aktor do audytu (domyślnie human-cli).' })
  parseActor(val: string): string {
    return val;
  }
}
