import { Command, CommandRunner, Option } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';
import { printTokenReveal } from './print';

interface CreateProjectOptions {
  slug?: string;
}

@Command({
  name: 'create-project',
  arguments: '<name> [label]',
  description:
    'Tworzy projekt i generuje pierwszy bearer token (widoczny raz). label domyślnie "default"; ' +
    '--slug <slug> ustawia slug (domyślnie wyprowadzany z nazwy).',
})
export class CreateProjectCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(inputs: string[], options: CreateProjectOptions = {}): Promise<void> {
    const name = inputs[0]?.trim();
    if (!name) {
      throw new Error('Podaj nazwę projektu: create-project <name> [label] [--slug <slug>]');
    }
    const label = inputs[1]?.trim();
    // Slug opcjonalny (roadmap v1.5) — bez flagi wyprowadzany z nazwy (jak dotąd; `install.sh` nie
    // podaje flagi). Format/unikalność waliduje `ProjectsService.createProject` (polski błąd).
    const { project, token, tokenRow } = await this.projects.createProject(name, {
      label,
      slug: options.slug?.trim(),
    });
    printTokenReveal(project, token, 'utworzony', tokenRow.label);
  }

  @Option({
    flags: '--slug <slug>',
    description: 'Slug projektu (a–z, 0–9, myślniki; 2–48 zn.) do nagłówka X-Context-Keeper-Project.',
  })
  parseSlug(val: string): string {
    return val;
  }
}
