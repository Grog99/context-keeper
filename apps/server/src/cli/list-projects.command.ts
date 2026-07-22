import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';

@Command({
  name: 'list-projects',
  description: 'Wypisuje projekty (id, status tokena, nazwa) — bez tokenów.',
})
export class ListProjectsCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(): Promise<void> {
    const rows = await this.projects.listProjects();
    if (rows.length === 0) {
      console.log('Brak projektów. Utwórz pierwszy: create-project <name>');
      return;
    }
    console.log('ID\t\tTOKEN\t\tNAZWA');
    for (const p of rows) {
      console.log(`${p.id}\t${p.tokenStatus}\t${p.name}`);
    }
  }
}
