import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DbModule } from '../db/db.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { MemoryModule } from '../memory/memory.module';
import { NightlyModule } from '../nightly/nightly.module';
import { ProjectsModule } from '../projects/projects.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { ApproveProposalCommand } from './approve-proposal.command';
import { CreateProjectCommand } from './create-project.command';
import { EditProposalCommand } from './edit-proposal.command';
import { ListProjectsCommand } from './list-projects.command';
import { ListProposalsCommand } from './list-proposals.command';
import { ReembedCommand } from './reembed.command';
import { RejectProposalCommand } from './reject-proposal.command';
import { RotateTokenCommand } from './rotate-token.command';
import { RunNightlyCommand } from './run-nightly.command';
import { SeedMemoryCommand } from './seed-memory.command';

/**
 * Standalone context CLI (nest-commander) — reużywa te same serwisy co ścieżka HTTP.
 * Uruchamiane: `docker compose run --rm app pnpm cli <cmd>` albo `pnpm cli:dev <cmd>`.
 * `NightlyModule` importowany TYLKO tutaj (nie w `AppModule`, Faza 6 plan §1) — nocny job żyje
 * wyłącznie w tym standalone kontekście, nigdy w procesie HTTP.
 */
@Module({
  imports: [
    ConfigModule.forRoot(),
    DbModule,
    EmbeddingsModule,
    ProjectsModule,
    MemoryModule,
    ProposalsModule,
    NightlyModule,
  ],
  providers: [
    CreateProjectCommand,
    RotateTokenCommand,
    ListProjectsCommand,
    SeedMemoryCommand,
    ReembedCommand,
    ListProposalsCommand,
    ApproveProposalCommand,
    RejectProposalCommand,
    EditProposalCommand,
    RunNightlyCommand,
  ],
})
export class CliModule {}
