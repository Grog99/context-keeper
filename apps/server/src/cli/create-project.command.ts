import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';
import { printTokenReveal } from './print';

@Command({
  name: 'create-project',
  arguments: '<name> [label]',
  description: 'Tworzy projekt i generuje pierwszy bearer token (widoczny raz). label domyślnie "default".',
})
export class CreateProjectCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const name = inputs[0]?.trim();
    if (!name) {
      throw new Error('Podaj nazwę projektu: create-project <name> [label]');
    }
    const label = inputs[1]?.trim();
    const { project, token, tokenRow } = await this.projects.createProject(name, label);
    printTokenReveal(project, token, 'utworzony', tokenRow.label);
  }
}
