/**
 * Taksonomia błędów MCP (§5 tech-stack, FR-M7). Błędy *wykonania narzędzia* → `isError: true`
 * + koperta `{code, message}` (agent czyta `code` i się adaptuje). `code` stabilne — komunikaty
 * tekstowe mogą się zmieniać. Błędy *transportu/auth* (401/429) idą osobną ścieżką (HttpException).
 */
export type ToolErrorCode = 'validation_error' | 'secret_blocked' | 'not_found' | ProjectScopeErrorCode;

/** Roadmap v1.5 ("Rozwiązywanie scope'u") — powody, dla których token jest ważny, ale projekt nie
 * został rozwiązany. Poziom NARZĘDZIA (nie HTTP 4xx): klient MCP przy 4xx oznaczyłby serwer jako
 * niepodłączony i agent nie zobaczyłby wskazówki (`details.projects`). */
export type ProjectScopeErrorCode =
  | 'project_required'
  | 'project_not_found'
  | 'project_pending'
  | 'project_forbidden';

/** Pozycja listy projektów w `details.projects` — wyłącznie dla tokenu konta (anty-probing). */
export interface ProjectSummary {
  slug: string;
  name: string;
}

/** Strukturalne dane obok `message` (które jest z definicji niestabilne) — `code` i kształt
 * `details` są stabilne, agent może je parsować. */
export interface ToolErrorDetails {
  projects?: ProjectSummary[];
}

export interface ToolErrorEnvelope {
  code: ToolErrorCode;
  message: string;
  details?: ToolErrorDetails;
}

/** Rzucany przez warstwę logiki (`MemoryService`); łapany na granicy rejestracji narzędzia MCP. */
export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly details?: ToolErrorDetails,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function toErrorEnvelope(err: ToolError): ToolErrorEnvelope {
  // `details` tylko gdy obecne — istniejące asercje `toEqual({code, message})` zostają prawdziwe.
  return err.details
    ? { code: err.code, message: err.message, details: err.details }
    : { code: err.code, message: err.message };
}
