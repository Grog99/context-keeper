import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';
import { printTokenReveal } from './print';

/** Token KONTA (roadmap v1.5, ticket #20) — jeden token do wielu repo, projekt wskazuje nagłówek
 * `X-Context-Keeper-Project`. Parytet z dashboardem ("Projekty → Tokeny konta"); `<label>` wymagana. */
@Command({
  name: 'create-account-token',
  arguments: '<label>',
  description:
    'Tworzy token konta (widoczny raz) — działa we WSZYSTKICH projektach instancji. label wymagana. ' +
    'Do CI i współpracowników użyj tokenów projektowych (create-token).',
})
export class CreateAccountTokenCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const label = inputs[0]?.trim();
    if (!label) {
      throw new Error('Podaj etykietę: create-account-token <label>');
    }
    const { token, tokenRow } = await this.projects.createAccountToken(label);
    printTokenReveal(null, token, 'utworzony', tokenRow.label);
  }
}
