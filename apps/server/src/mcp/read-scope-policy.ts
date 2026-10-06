import { ToolError } from '../common/errors';
import type { ReadScope } from '../memory/read-scope';
import type { TokenScope } from '../projects/project-scope';

/**
 * Polityka typ tokena -> zakres odczytu (roadmap v1.5, "Wyszukiwanie między projektami") — jedyne
 * miejsce, które zna typy tokenów w tej sprawie; `MemoryService` dostaje gotowy `ReadScope`.
 * Czyste funkcje, żeby dało się je testować bez serwera MCP.
 */

/** Komunikat po angielsku (jak opisy narzędzi — agent czyta go w swoim kontekście). */
export const ALL_PROJECTS_REQUIRES_ACCOUNT_TOKEN =
  'all_projects requires an account token. A project token searches only its own project plus global ' +
  'memories — omit all_projects (or pass false), or use an account token.';

/**
 * Zakres `search_memory`: `all_projects: true` tylko dla tokenu konta, token projektowy dostaje jawny
 * `validation_error` (zamiast cichego zignorowania). Rzucany PRZED `memory.search`, więc nie zostawia
 * wiersza `search_events`.
 */
export function searchReadScope(tokenScope: TokenScope, allProjects: boolean): ReadScope {
  if (!allProjects) return 'project';
  if (tokenScope !== 'account') {
    throw new ToolError('validation_error', ALL_PROJECTS_REQUIRES_ACCOUNT_TOKEN);
  }
  return 'all_projects';
}

/** Zakres `get_memory` (G6): token konta czyta pamięć dowolnego projektu, projektowy jak dotąd. */
export function getReadScope(tokenScope: TokenScope): ReadScope {
  return tokenScope === 'account' ? 'all_projects' : 'project';
}
