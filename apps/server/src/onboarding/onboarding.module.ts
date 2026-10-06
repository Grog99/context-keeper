import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ProjectsModule } from '../projects/projects.module';
import { OnboardingService } from './onboarding.service';
import { ProjectProposalService } from './project-proposal.service';

/**
 * Backend onboardingu (roadmap v1.5, scope B): bloki `.mcp.json`/`AGENTS.md` (`OnboardingService`) i
 * producent propozycji `create_project` (`ProjectProposalService`). Importowany przez `McpModule`
 * (narzędzia konta) i `DashboardModule` (endpoint `GET /api/onboarding` dla ekranu "Onboarding").
 * Zależności: Projects, Audit — bez cykli (Proposals nie zna tego modułu).
 */
@Module({
  imports: [ProjectsModule, AuditModule],
  providers: [OnboardingService, ProjectProposalService],
  exports: [OnboardingService, ProjectProposalService],
})
export class OnboardingModule {}
