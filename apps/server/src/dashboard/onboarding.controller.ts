import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { OnboardingService, type DashboardOnboarding } from '../onboarding/onboarding.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { emptyQuery } from './dashboard.schemas';
import { DashboardErrorFilter } from './dashboard-error.filter';

/**
 * Ekran "Onboarding" (roadmap v1.5, ticket #19) — bloki `.mcp.json` / `AGENTS.md` / `CLAUDE.md` renderuje
 * SERWER (`OnboardingService`, jedno źródło z narzędziami MCP `list_projects`/`create_project`); SPA
 * tylko je wyświetla. Odpowiedź nigdy nie niesie tokenów — token konta pokazuje wyłącznie
 * `TokenReveal` po wydaniu/rotacji. Endpoint bez filtrów, ale query wciąż strict (Q1, jak `/api/config`).
 */
@Controller('api/onboarding')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  get(@Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>): Promise<DashboardOnboarding> {
    return this.onboarding.forDashboard();
  }
}
