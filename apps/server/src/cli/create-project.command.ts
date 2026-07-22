import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';
import { printTokenReveal } from './print';

@Command({
  name: 'create-project',
  arguments: '<name>',
  description: 'Tworzy projekt i generuje bearer token (widoczny raz).',
})
export class CreateProjectCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const name = inputs[0]?.trim();
    if (!name) {
      throw new Error('Podaj nazwę projektu: create-project <name>');
    }
    const { project, token } = await this.projects.createProject(name);
    printTokenReveal(project, token, 'utworzony');
  }
}
