import type { Request } from 'express';
import type { ProjectScopeErrorCode } from '../common/errors';
import type { ProjectRow } from '../db/schema';
import { isValidProjectSlug, normalizeProjectSlugInput } from './slug';
import type { ProjectContext, PublicTokenRow } from './projects.service';

/**
 * Rozwiązywanie scope'u projektu dla żądania MCP (roadmap v1.5, "Rozwiązywanie scope'u" — ticket
 * #1, #4, #12, #21). Guard auth NIE odrzuca żądania z powodu projektu: każdy ważny token przechodzi,
 * a stan "projekt nierozwiązany (+ powód)" jedzie do `createMcpServer`, gdzie narzędzie pamięci
 * zwraca `isError` + `{code, message, details?}`. Przy HTTP 4xx klient MCP uznałby serwer za
 * niepodłączony i agent nie dostałby wskazówki — dlatego tool-level.
 */

/** Postać do wyświetlania (szablony `.mcp.json`, opisy narzędzi). */
export const PROJECT_HEADER_NAME = 'X-Context-Keeper-Project';
/** Nagłówek wskazujący projekt (Node lowercase'uje nazwy nagłówków w `req.headers`). */
export const PROJECT_HEADER = PROJECT_HEADER_NAME.toLowerCase();

export type TokenScope = 'project' | 'account';

/** Scope tokenu z jego `project_id`: `NULL` = token konta, inaczej projektowy (jedyne miejsce tej reguły). */
export function tokenScopeOf(projectId: string | null): TokenScope {
  return projectId === null ? 'account' : 'project';
}

export type ProjectResolution =
  | { status: 'resolved'; context: ProjectContext }
  | { status: 'unresolved'; reason: ProjectScopeErrorCode; requestedSlug?: string };

/** Kontekst po uwierzytelnieniu (wynik `BearerGuard`, wejście `createMcpServer`). */
export interface McpAuthContext {
  tokenId: string;
  tokenLabel: string;
  tokenScope: TokenScope;
  project: ProjectResolution;
}

export type RequestWithMcpAuth = Request & { mcpAuth?: McpAuthContext };

/** Pierwsza wartość nagłówka, trim + lowercase; pusta wartość = brak nagłówka. */
export function readProjectHeader(h: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(h) ? h[0] : h;
  if (raw === undefined) return undefined;
  const normalized = normalizeProjectSlugInput(raw);
  return normalized === '' ? undefined : normalized;
}

export function toProjectContext(project: ProjectRow, token: PublicTokenRow): ProjectContext {
  return {
    projectId: project.id,
    projectName: project.name,
    includeEventsInDefaultSearch: project.includeEventsInDefaultSearch,
    tokenId: token.id,
    tokenLabel: token.label,
  };
}

export interface ProjectScopeLookups {
  findBySlug(slug: string): Promise<ProjectRow | null>;
  isSlugPending(slug: string): Promise<boolean>;
}

/**
 * Kolejność wiążąca (ticket, "Kontrakt między planistami"):
 *  - token projektowy: brak nagłówka albo slug == własny → projekt tokena; inny slug →
 *    `project_forbidden` BEZ jakiegokolwiek zapytania do bazy i bez echa wartości (anty-probing:
 *    identyczna odpowiedź i czas niezależnie od tego, czy slug istnieje);
 *  - token konta: brak nagłówka → `project_required`; slug w złym formacie → `project_not_found`
 *    (bez zapytania); trafienie w `projects.slug` → projekt; oczekująca propozycja → `project_pending`;
 *    inaczej → `project_not_found`.
 * `requestedSlug` zwracany tylko dla slugów poprawnych formatem (echo do komunikatu).
 */
export async function resolveProjectScope(
  input: { token: PublicTokenRow; tokenProject: ProjectRow | null; slug: string | undefined },
  lookups: ProjectScopeLookups,
): Promise<ProjectResolution> {
  const { token, tokenProject, slug } = input;

  if (token.projectId !== null) {
    // Scope decyduje `projectId` tokena (nie "brak wiersza projektu" — FK cascade czyni to niemożliwym).
    if (!tokenProject) {
      return { status: 'unresolved', reason: 'project_not_found' }; // defensywnie: nieosiągalne
    }
    if (slug === undefined || slug === tokenProject.slug) {
      return { status: 'resolved', context: toProjectContext(tokenProject, token) };
    }
    return { status: 'unresolved', reason: 'project_forbidden' };
  }

  if (slug === undefined) {
    return { status: 'unresolved', reason: 'project_required' };
  }
  if (!isValidProjectSlug(slug)) {
    return { status: 'unresolved', reason: 'project_not_found' };
  }
  const project = await lookups.findBySlug(slug);
  if (project) {
    return { status: 'resolved', context: toProjectContext(project, token) };
  }
  if (await lookups.isSlugPending(slug)) {
    return { status: 'unresolved', reason: 'project_pending', requestedSlug: slug };
  }
  return { status: 'unresolved', reason: 'project_not_found', requestedSlug: slug };
}
