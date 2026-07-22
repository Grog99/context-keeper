export type PurgeErrorCode = 'not_found' | 'already_purged' | 'validation_error';

/**
 * Błąd domenowy hard-purge (FR-S3, §10 tech-stack) — mirror `proposals/proposals.errors.ts`.
 * Osobny typ (nie `ToolError`) bo purge nie jest narzędziem MCP — wyłącznie CLI (`purge.command.ts`).
 */
export class PurgeError extends Error {
  constructor(
    public readonly code: PurgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PurgeError';
  }
}
