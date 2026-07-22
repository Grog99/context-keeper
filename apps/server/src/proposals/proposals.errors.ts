export type ProposalErrorCode = 'not_found' | 'already_decided' | 'stale' | 'validation_error';

/**
 * Błąd domenowy kolejki akceptacji — mirror `common/errors.ts:ToolError`, osobny bo `proposals`
 * to dziś warstwa serwisowa konsumowana przez CLI (nie narzędzie MCP) — HTTP przyjdzie w Fazie 5.
 *
 * Mapowanie HTTP dla Fazy 5 (`SessionGuard` + kontroler, §1.7 planu Fazy 4):
 *   not_found        -> 404
 *   already_decided  -> 409 { code: 'already_decided' }
 *   stale            -> 409 { code: 'stale', staleIds }
 *   validation_error -> 400
 */
export class ProposalError extends Error {
  constructor(
    public readonly code: ProposalErrorCode,
    message: string,
    public readonly staleIds?: string[],
    public readonly currentStatus?: string,
  ) {
    super(message);
    this.name = 'ProposalError';
  }
}
