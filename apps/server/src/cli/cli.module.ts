import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DbModule } from '../db/db.module';
import { ProjectsModule } from '../projects/projects.module';
import { CreateProjectCommand } from './create-project.command';
import { ListProjectsCommand } from './list-projects.command';
import { RotateTokenCommand } from './rotate-token.command';

/**
 * Standalone context CLI (nest-commander) — reużywa te same serwisy co ścieżka HTTP.
 * Uruchamiane: `docker compose run --rm app pnpm cli <cmd>` albo `pnpm cli:dev <cmd>`.
 */
@Module({
  imports: [ConfigModule.forRoot(), DbModule, ProjectsModule],
  providers: [CreateProjectCommand, RotateTokenCommand, ListProjectsCommand],
})
export class CliModule {}
