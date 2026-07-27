import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';
import { printTokenReveal } from './print';

/** Nowy token OBOK istniejących (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") —
 * `<label>` wymagana (atrybucja per-agent, §0 pkt 3 planu). */
@Command({
  name: 'create-token',
  arguments: '<projectId> <label>',
  description: 'Dodaje nowy bearer token do istniejącego projektu (widoczny raz). label wymagana.',
})
export class CreateTokenCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const projectId = inputs[0]?.trim();
    const label = inputs[1]?.trim();
    if (!projectId || !label) {
      throw new Error('Podaj: create-token <projectId> <label>');
    }
    const { tokenRow, token } = await this.projects.createToken(projectId, label);
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new Error(`Projekt nie istnieje: ${projectId}`);
    }
    printTokenReveal(project, token, 'utworzony', tokenRow.label);
  }
}
