import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';
import { printTokenReveal } from './print';

@Command({
  name: 'rotate-token',
  arguments: '<projectId>',
  description: 'Rotuje token projektu (hard-cutover — stary token przestaje działać natychmiast).',
})
export class RotateTokenCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const projectId = inputs[0]?.trim();
    if (!projectId) {
      throw new Error('Podaj id projektu: rotate-token <projectId>');
    }
    const { project, token } = await this.projects.rotateToken(projectId);
    printTokenReveal(project, token, 'zrotowany');
  }
}
