import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ToolError, type ToolErrorCode } from '../common/errors';
import { ProposalError, type ProposalErrorCode } from '../proposals/proposals.errors';
import { PurgeError, type PurgeErrorCode } from '../purge/purge.errors';

const PROPOSAL_STATUS: Record<ProposalErrorCode, HttpStatus> = {
  not_found: HttpStatus.NOT_FOUND,
  already_decided: HttpStatus.CONFLICT,
  stale: HttpStatus.CONFLICT,
  validation_error: HttpStatus.BAD_REQUEST,
};

const TOOL_STATUS: Record<ToolErrorCode, HttpStatus> = {
  validation_error: HttpStatus.BAD_REQUEST,
  secret_blocked: HttpStatus.UNPROCESSABLE_ENTITY,
  not_found: HttpStatus.NOT_FOUND,
};

/** Roadmap v1.1 — hard-purge z dashboardu (`MemoriesController.purge`/`purgePreview`), kontrakt w
 * `purge/purge.errors.ts`. Bez tego `PurgeError` spadałby na domyślny handler Nesta jako 500. */
const PURGE_STATUS: Record<PurgeErrorCode, HttpStatus> = {
  not_found: HttpStatus.NOT_FOUND,
  already_purged: HttpStatus.CONFLICT,
  validation_error: HttpStatus.BAD_REQUEST,
};

/**
 * Mapuje błędy domenowe kolejki/pamięci (`ProposalError` — kontrakt już udokumentowany w
 * `proposals.errors.ts`; `ToolError` — kontrakt w `common/errors.ts`; `PurgeError` — hard-purge,
 * kontrakt w `purge/purge.errors.ts`) na HTTP dla powierzchni dashboardu (§M1 planu).
 * `ProposalError('stale')` niesie dodatkowo `staleIds` w kopercie — SPA używa ich do podświetlenia
 * konfliktu (`ProposalActions` disabled + alert, §8.2 design-systemu).
 */
@Catch(ProposalError, ToolError, PurgeError)
export class DashboardErrorFilter implements ExceptionFilter {
  catch(exception: ProposalError | ToolError | PurgeError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ProposalError) {
      const status = PROPOSAL_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
      res.status(status).json({
        code: exception.code,
        message: exception.message,
        ...(exception.staleIds ? { staleIds: exception.staleIds } : {}),
      });
      return;
    }
    if (exception instanceof PurgeError) {
      const status = PURGE_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
      res.status(status).json({ code: exception.code, message: exception.message });
      return;
    }
    const status = TOOL_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    res.status(status).json({ code: exception.code, message: exception.message });
  }
}
