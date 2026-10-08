import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LlmSettingsService } from '../llm/llm-settings.service';
import { LlmService } from '../llm/llm.service';
import {
  EMPTY_LLM_COUNTERS,
  type LlmCheckResult,
  type LlmCounters,
  type LlmRunState,
  type LlmSettingsDto,
  type NightlyLlmReport,
  type SkippedSecretEntry,
} from '../llm/llm.types';
import {
  EMPTY_LLM_CONFLICT_COUNTERS,
  EMPTY_LLM_PRUNE_COUNTERS,
  type LlmConflictCounters,
  type LlmPruneCounters,
} from '../nightly/nightly.types';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { DASHBOARD_ACTOR } from './dashboard.constants';
import { emptyBody, emptyQuery, llmSettingsBody, type LlmSettingsBody } from './dashboard.schemas';
import { DashboardErrorFilter } from './dashboard-error.filter';

export interface LlmLastRun {
  at: string;
  status: 'success';
  counters: LlmCounters & LlmPruneCounters & LlmConflictCounters;
  /** `null` dla przebiegów sprzed v1.6 (bez bloku `llm` w metadanych). */
  llm: NightlyLlmReport | null;
}

export interface LlmSettingsResponse {
  settings: LlmSettingsDto;
  /** Ostatni UDANY `nightly_run` albo `null`, gdy żadnego jeszcze nie było. */
  lastRun: LlmLastRun | null;
}

const RUN_STATES: readonly LlmRunState[] = ['disabled', 'ready', 'key_unreadable', 'unavailable'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Starsze wiersze `nightly_run` nie mają pól LLM — brakujące liczniki to 0, brakujący blok to `null`. */
function pickCounters(raw: unknown): LlmCounters & LlmPruneCounters & LlmConflictCounters {
  const out: LlmCounters & LlmPruneCounters & LlmConflictCounters = {
    ...EMPTY_LLM_COUNTERS,
    ...EMPTY_LLM_PRUNE_COUNTERS,
    ...EMPTY_LLM_CONFLICT_COUNTERS,
  };
  if (!isRecord(raw)) return out;
  for (const key of Object.keys(out) as (keyof typeof out)[]) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

function pickLlmReport(raw: unknown): NightlyLlmReport | null {
  if (!isRecord(raw)) return null;
  const state = RUN_STATES.find((s) => s === raw.state);
  if (!state) return null;
  const skippedSecret: SkippedSecretEntry[] = [];
  if (Array.isArray(raw.skippedSecret)) {
    for (const e of raw.skippedSecret) {
      if (isRecord(e) && typeof e.memoryId === 'string' && typeof e.secretType === 'string') {
        skippedSecret.push({ memoryId: e.memoryId, secretType: e.secretType as SkippedSecretEntry['secretType'] });
      }
    }
  }
  return { state, skippedSecret };
}

/**
 * Ustawienia instancji — sekcja „Model LLM" (roadmap v1.6, G3–G7, G11–G14), cienki wrapper nad
 * `LlmSettingsService`/`LlmService`. Guardy kontroler-scoped jak reszta dashboardu. Klucz API jest
 * write-only: żadna odpowiedź nie niesie go ani jego fragmentu (`apiKey: 'none'|'set'|'unreadable'`).
 *
 * `POST /check` robi server-side żądanie pod adres wskazany przez zalogowanego admina (jedna płatna
 * próba na kliknięcie, nie sonda) i zwraca wynik jako dane — zawsze 200, `{ok:false, error}` to normalna odpowiedź.
 */
@Controller('api/settings/llm')
@UseGuards(SessionGuard, CsrfGuard)
@UseFilters(DashboardErrorFilter)
export class SettingsController {
  constructor(
    private readonly settings: LlmSettingsService,
    private readonly llm: LlmService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async get(
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<LlmSettingsResponse> {
    const [settings, lastRunRow] = await Promise.all([
      this.settings.getPublic(),
      this.audit.latestByEventType('nightly_run', { status: 'success' }),
    ]);
    const meta = isRecord(lastRunRow?.metadata) ? lastRunRow.metadata : null;
    return {
      settings,
      lastRun:
        lastRunRow && meta
          ? {
              at: lastRunRow.createdAt.toISOString(),
              status: 'success',
              counters: pickCounters(meta.counters),
              llm: pickLlmReport(meta.llm),
            }
          : null,
    };
  }

  @Put()
  async update(
    @Body(new ZodValidationPipe(llmSettingsBody)) body: LlmSettingsBody,
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
  ): Promise<LlmSettingsDto> {
    return this.settings.update(body, DASHBOARD_ACTOR);
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  async check(
    @Query(new ZodValidationPipe(emptyQuery)) _query: Record<string, never> = {},
    @Body(new ZodValidationPipe(emptyBody)) _body: Record<string, never> = {},
  ): Promise<LlmCheckResult> {
    return this.llm.checkConnection();
  }
}
