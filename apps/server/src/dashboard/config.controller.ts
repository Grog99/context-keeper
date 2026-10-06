import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { HEADER_MAX_LEN } from '../memory/validation';
import { resolveMcpPublicUrl } from '../onboarding/mcp-public-url';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { emptyQuery } from './dashboard.schemas';
import { DashboardErrorFilter } from './dashboard-error.filter';

export interface DashboardLimits {
  headerMaxLen: number;
  bodyMaxFact: number;
  bodyMaxDocument: number;
  /** `kind=event` (roadmap v1.2, "kind=event episodic") — licznik znaków w `HumanCreateDialog`. */
  bodyMaxEvent: number;
  tagsMax: number;
  tagMaxLen: number;
  /** Publiczny origin powierzchni `/mcp` (bez ścieżki), do snippetu ekranu "Onboarding" (roadmap
   * v1.2) — `null` gdy operator nie skonfigurował ani `PUBLIC_MCP_URL`, ani `ACME_DOMAIN`. */
  mcpPublicUrl: string | null;
}

/**
 * §M4 planu Fazy 5 — `HumanCreateDialog` potrzebuje limitów per-kind do liczników znaków
 * (`BODY_MAX_FACT`/`BODY_MAX_DOCUMENT` są env-configurable, §Ryzyka planu "Human-create...
 * header/body counters"), a frontend nie ma innego sposobu poznania ich niż zapytać serwer —
 * stąd ten mały, czysto odczytowy dodatek do API M1 (dozwolony w brief, gdy M1 czegoś nie pokrywa).
 *
 * Walidacja query (tech-review #3, roadmap v1.4, Q1 resolved "strict everywhere") — endpoint nie
 * przyjmuje żadnych filtrów, ale nieznany klucz query dalej jest 400, nie ciche zignorowanie.
 */
@Controller('api/config')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class ConfigController {
  constructor(private readonly config: AppConfigService) {}

  @Get()
  get(@Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never>): DashboardLimits {
    return {
      headerMaxLen: HEADER_MAX_LEN,
      bodyMaxFact: this.config.get('BODY_MAX_FACT'),
      bodyMaxDocument: this.config.get('BODY_MAX_DOCUMENT'),
      bodyMaxEvent: this.config.get('BODY_MAX_EVENT'),
      tagsMax: this.config.get('TAGS_MAX'),
      tagMaxLen: this.config.get('TAG_MAX_LEN'),
      mcpPublicUrl: resolveMcpPublicUrl(this.config),
    };
  }
}
