import { ToolError } from '../common/errors';

/** Limit nazwy projektu z propozycji `create_project` (zgodny z `inputSchema` narzędzia MCP). */
export const PROJECT_NAME_MAX_LEN = 200;

/**
 * Normalizacja nazwy projektu podanej przez agenta (`create_project`): trim, białe znaki i znaki
 * nowej linii zwinięte do jednej spacji (nazwa jest jednolinijkowa — trafia do kolejki, selektora
 * projektów i audytu), długość 1–200. Pure; błąd → `ToolError('validation_error')` (komunikat
 * agent-facing, angielski).
 */
export function normalizeProjectName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length === 0) {
    throw new ToolError('validation_error', 'Project name must not be empty.');
  }
  if (name.length > PROJECT_NAME_MAX_LEN) {
    throw new ToolError(
      'validation_error',
      `Project name is too long (max ${PROJECT_NAME_MAX_LEN} characters, got ${name.length}).`,
    );
  }
  return name;
}
