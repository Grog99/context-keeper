import type { AppConfigService } from '../../src/config/config.service';
import type { Database } from '../../src/db/db.tokens';
import { ProjectSlugService } from '../../src/projects/project-slug.service';
import { ProjectsService } from '../../src/projects/projects.service';

/** `ProjectsService` z jego zależnościami zbudowanymi ręcznie (testy integracyjne bez Nest DI). */
export function buildProjectsService(db: Database, config: AppConfigService): ProjectsService {
  return new ProjectsService(db, config, new ProjectSlugService(db));
}
