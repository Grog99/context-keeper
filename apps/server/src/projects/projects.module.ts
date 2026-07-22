import { Module } from '@nestjs/common';
import { BearerGuard } from './bearer.guard';
import { ProjectsService } from './projects.service';

@Module({
  providers: [ProjectsService, BearerGuard],
  exports: [ProjectsService, BearerGuard],
})
export class ProjectsModule {}
