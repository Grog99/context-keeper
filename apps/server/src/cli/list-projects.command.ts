import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';

/**
 * ⚠️ `install.sh` parsuje wyjście tej komendy: `awk -F'\t' '$3==want'` szuka nazwy projektu w POLU 3
 * (roadmap v1.3 §G planu, §Risks "install.sh parsuje CLI output"). Kolumny MUSZĄ zostać dokładnie 3,
 * tab-separated, nazwa MUSI zostać w polu 3 — nie przestawiaj/nie dokładaj kolumny bez zmiany
 * `install.sh:596` w tym samym commicie.
 */
@Command({
  name: 'list-projects',
  description: 'Wypisuje projekty (id, tokeny, nazwa) — bez wartości tokenów.',
})
export class ListProjectsCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(): Promise<void> {
    const [rows, tokenCounts] = await Promise.all([
      this.projects.listProjects(),
      this.projects.countTokensByProject(),
    ]);
    if (rows.length === 0) {
      console.log('Brak projektów. Utwórz pierwszy: create-project <name> [label]');
      return;
    }
    console.log('ID\tTOKENS\tNAZWA');
    for (const p of rows) {
      const counts = tokenCounts.get(p.id) ?? { active: 0, grace: 0, revoked: 0 };
      // Pole 2 (dawniej `tokenStatus`, teraz usunięty ze schematu) — skrótowy podsumowujący format
      // "aktywne/karencja" (revoked pominięty — nieużywalny, nieinteresujący w tym podglądzie).
      console.log(`${p.id}\ttokens:${counts.active}/${counts.grace}\t${p.name}`);
    }
  }
}
