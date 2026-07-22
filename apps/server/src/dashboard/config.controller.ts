import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { HEADER_MAX_LEN } from '../memory/validation';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DashboardErrorFilter } from './dashboard-error.filter';

export interface DashboardLimits {
  headerMaxLen: number;
  bodyMaxFact: number;
  bodyMaxDocument: number;
  tagsMax: number;
  tagMaxLen: number;
}

/**
 * §M4 planu Fazy 5 — `HumanCreateDialog` potrzebuje limitów per-kind do liczników znaków
 * (`BODY_MAX_FACT`/`BODY_MAX_DOCUMENT` są env-configurable, §Ryzyka planu "Human-create...
 * header/body counters"), a frontend nie ma innego sposobu poznania ich niż zapytać serwer —
 * stąd ten mały, czysto odczytowy dodatek do API M1 (dozwolony w brief, gdy M1 czegoś nie pokrywa).
 */
@Controller('api/config')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class ConfigController {
  constructor(private readonly config: AppConfigService) {}

  @Get()
  get(): DashboardLimits {
    return {
      headerMaxLen: HEADER_MAX_LEN,
      bodyMaxFact: this.config.get('BODY_MAX_FACT'),
      bodyMaxDocument: this.config.get('BODY_MAX_DOCUMENT'),
      tagsMax: this.config.get('TAGS_MAX'),
      tagMaxLen: this.config.get('TAG_MAX_LEN'),
    };
  }
}
