/**
 * Taksonomia błędów MCP (§5 tech-stack, FR-M7). Błędy *wykonania narzędzia* → `isError: true`
 * + koperta `{code, message}` (agent czyta `code` i się adaptuje). `code` stabilne — komunikaty
 * tekstowe mogą się zmieniać. Błędy *transportu/auth* (401/429) idą osobną ścieżką (HttpException).
 */
export type ToolErrorCode = 'validation_error' | 'secret_blocked' | 'not_found';

export interface ToolErrorEnvelope {
  code: ToolErrorCode;
  message: string;
}

/** Rzucany przez warstwę logiki (`MemoryService`); łapany na granicy rejestracji narzędzia MCP. */
export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function toErrorEnvelope(err: ToolError): ToolErrorEnvelope {
  return { code: err.code, message: err.message };
}
