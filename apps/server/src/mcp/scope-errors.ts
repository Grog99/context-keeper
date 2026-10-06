import { ToolError, type ProjectSummary } from '../common/errors';
import { PROJECT_HEADER_NAME, type ProjectResolution } from '../projects/project-scope';
import type { ProjectSlugService } from '../projects/project-slug.service';

/** Ile slugów wymieniamy w `message` błędu scope'u — pełna lista zawsze w `details.projects`. */
export const MESSAGE_SLUG_CAP = 20;

export function describeProjects(projects: ProjectSummary[]): string {
  if (projects.length === 0) {
    return 'There are no projects on this instance yet — propose one with create_project({name, slug}); a human approves it in the dashboard.';
  }
  const shown = projects.slice(0, MESSAGE_SLUG_CAP).map((p) => p.slug);
  const more = projects.length - shown.length;
  return `Known projects: ${shown.join(', ')}${more > 0 ? ` (+${more} more, see details.projects)` : ''}.`;
}

/**
 * Błąd tool-level dla projektu nierozwiązanego (roadmap v1.5, ticket #12/#21). Listę projektów
 * (`details.projects`) pobieramy LENIWIE — wyłącznie tutaj, więc `initialize`/`tools/list` nie kosztują
 * zapytania do bazy. Anty-probing: `project_forbidden` (token projektowy + obcy nagłówek) ma stały
 * komunikat, bez `details` i bez echa wartości nagłówka — identyczny niezależnie od istnienia slugu.
 * Komunikaty są agent-facing (angielski, jak `tool-contract.ts`).
 */
export async function buildScopeError(
  unresolved: Extract<ProjectResolution, { status: 'unresolved' }>,
  lookups: Pick<ProjectSlugService, 'listProjectSummaries'>,
): Promise<ToolError> {
  switch (unresolved.reason) {
    case 'project_required': {
      const list = await lookups.listProjectSummaries();
      return new ToolError(
        'project_required',
        `This account token is not bound to a project. Set the "${PROJECT_HEADER_NAME}: <slug>" header ` +
          `(in the repo's .mcp.json) to choose the project — call list_projects for ready-made .mcp.json blocks. ` +
          describeProjects(list),
        { projects: list },
      );
    }
    case 'project_not_found': {
      const list = await lookups.listProjectSummaries();
      const what = unresolved.requestedSlug
        ? `No project with slug "${unresolved.requestedSlug}" exists.`
        : 'The project slug in the header is malformed (lowercase a-z, digits and single hyphens, 2-48 chars).';
      return new ToolError(
        'project_not_found',
        `${what} Fix the "${PROJECT_HEADER_NAME}" header value, or propose the project with create_project({name, slug}) ` +
          `(a human approves it). ${describeProjects(list)}`,
        { projects: list },
      );
    }
    case 'project_pending':
      return new ToolError(
        'project_pending',
        `Project "${unresolved.requestedSlug ?? ''}" is awaiting human approval in the dashboard queue — ` +
          'memory tools will work once it is approved. This is not retryable right now; do not call in a loop, ' +
          'and do not call create_project again for it.',
      );
    case 'project_forbidden':
      return new ToolError(
        'project_forbidden',
        `This token is bound to a single project and cannot be used with the "${PROJECT_HEADER_NAME}" ` +
          'header value that was sent. Remove the header, or use a token that is valid for that project.',
      );
  }
}
