import { Controller, Post, UseFilters, UseGuards } from '@nestjs/common';
import { NightlyService } from '../nightly/nightly.service';
import type { NightlyRunResult } from '../nightly/nightly.types';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DASHBOARD_ACTOR } from './dashboard.constants';
import { DashboardErrorFilter } from './dashboard-error.filter';

/**
 * Ręczny trigger nocnego joba z dashboardu (roadmap v1.1, ekran "Operacje") — cienki wrapper nad
 * `NightlyService.run()` (§Guiding principle planu dashboard-nightly-purge: zero reimplementacji
 * logiki, CLI `run-nightly` i ten endpoint wołają dokładnie ten sam serwis, więc CLI/UI parity jest
 * strukturalna, nie duplikowana). Guardy kontroler-scoped, jak wszystkie kontrolery dashboardu
 * (§Ryzyka planu — NIGDY globalne, `/mcp` nie może dostać nowego globalnego guarda).
 *
 * Synchroniczny POST — blokuje do końca przebiegu (advisory lock + pełny skan approved facts).
 * `status: 'skipped-locked'` to normalna odpowiedź 200 (drugi równoległy trigger), nie błąd.
 */
@Controller('api/nightly')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class NightlyController {
  constructor(private readonly nightly: NightlyService) {}

  @Post('run')
  async run(): Promise<NightlyRunResult> {
    return this.nightly.run({ actor: DASHBOARD_ACTOR });
  }
}
