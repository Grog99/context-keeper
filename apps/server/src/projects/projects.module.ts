import { Module } from '@nestjs/common';
import { BearerGuard } from './bearer.guard';
import { ProjectSlugService } from './project-slug.service';
import { ProjectsService } from './projects.service';

@Module({
  providers: [ProjectSlugService, ProjectsService, BearerGuard],
  exports: [ProjectSlugService, ProjectsService, BearerGuard],
})
export class ProjectsModule {}
