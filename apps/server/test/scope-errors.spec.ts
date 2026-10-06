import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../src/common/errors';
import { buildScopeError, describeProjects, MESSAGE_SLUG_CAP } from '../src/mcp/scope-errors';
import { PROJECT_HEADER_NAME, type ProjectResolution } from '../src/projects/project-scope';

type Unresolved = Extract<ProjectResolution, { status: 'unresolved' }>;

/** Fałszywe `listProjectSummaries` z licznikiem — błąd scope'u pobiera listę leniwie i tylko dla tokenu konta. */
function fakeLookups(projects: ProjectSummary[]) {
  const calls = { listProjectSummaries: 0 };
  return {
    calls,
    lookups: {
      async listProjectSummaries() {
        calls.listProjectSummaries++;
        return projects;
      },
    },
  };
}

function summaries(n: number): ProjectSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    slug: `proj-${String(i).padStart(2, '0')}`,
    name: `Project ${i}`,
  }));
}

const THREE = summaries(3);

describe('buildScopeError — mapowanie powodu na code', () => {
  it.each(['project_required', 'project_not_found', 'project_pending', 'project_forbidden'] as const)(
    'reason %s -> ToolError z tym samym code',
    async (reason) => {
      const { lookups } = fakeLookups(THREE);
      const err = await buildScopeError({ status: 'unresolved', reason, requestedSlug: 'proj-01' }, lookups);
      expect(err.code).toBe(reason);
    },
  );
});

describe('buildScopeError — details.projects', () => {
  it('project_required i project_not_found niosą pełną listę w details.projects', async () => {
    for (const reason of ['project_required', 'project_not_found'] as const) {
      const { lookups, calls } = fakeLookups(THREE);
      const err = await buildScopeError({ status: 'unresolved', reason, requestedSlug: 'nope-zzz' }, lookups);
      expect(err.details).toEqual({ projects: THREE });
      expect(calls.listProjectSummaries).toBe(1);
    }
  });

  it('project_pending i project_forbidden nie mają details i nie dotykają bazy', async () => {
    for (const reason of ['project_pending', 'project_forbidden'] as const) {
      const { lookups, calls } = fakeLookups(THREE);
      const err = await buildScopeError({ status: 'unresolved', reason, requestedSlug: 'proj-01' }, lookups);
      expect(err.details).toBeUndefined();
      expect(calls.listProjectSummaries).toBe(0);
    }
  });
});

describe('buildScopeError — lista slugów w message', () => {
  it('powyżej MESSAGE_SLUG_CAP projektów: message wymienia tylko tyle slugów + "(+N more…)", pełna lista w details', async () => {
    const all = summaries(MESSAGE_SLUG_CAP + 5);
    const { lookups } = fakeLookups(all);
    const err = await buildScopeError({ status: 'unresolved', reason: 'project_required' }, lookups);
    expect(err.message).toContain(all[MESSAGE_SLUG_CAP - 1].slug);
    expect(err.message).not.toContain(all[MESSAGE_SLUG_CAP].slug);
    expect(err.message).toContain('(+5 more, see details.projects)');
    expect(err.details?.projects).toHaveLength(MESSAGE_SLUG_CAP + 5);
  });

  it('dokładnie na limicie: bez sufiksu "(+N more…)"', async () => {
    const { lookups } = fakeLookups(summaries(MESSAGE_SLUG_CAP));
    const err = await buildScopeError({ status: 'unresolved', reason: 'project_required' }, lookups);
    expect(err.message).not.toContain('more');
  });

  it('zero projektów: komunikat o braku projektów, details.projects = []', async () => {
    const { lookups } = fakeLookups([]);
    const err = await buildScopeError({ status: 'unresolved', reason: 'project_required' }, lookups);
    expect(err.message).toContain('There are no projects on this instance yet');
    expect(err.details).toEqual({ projects: [] });
    expect(describeProjects([])).toContain('There are no projects');
  });
});

describe('buildScopeError — echo slugu i anty-probing', () => {
  it('project_forbidden: stały komunikat, bez details i bez echa wartości nagłówka', async () => {
    const { lookups } = fakeLookups(THREE);
    const a = await buildScopeError({ status: 'unresolved', reason: 'project_forbidden' }, lookups);
    const b = await buildScopeError(
      { status: 'unresolved', reason: 'project_forbidden', requestedSlug: 'secret-other-project' },
      lookups,
    );
    expect(a.message).toBe(b.message);
    expect(b.message).not.toContain('secret-other-project');
    expect(b.message).toContain(PROJECT_HEADER_NAME);
    expect(b.details).toBeUndefined();
  });

  it('project_not_found z niepoprawnym formatem (bez requestedSlug): komunikat "malformed", brak echa', async () => {
    const { lookups } = fakeLookups(THREE);
    const unresolved: Unresolved = { status: 'unresolved', reason: 'project_not_found' };
    const err = await buildScopeError(unresolved, lookups);
    expect(err.message).toContain('malformed');
    expect(err.message).not.toContain('No project with slug');
  });

  it('project_not_found z poprawnym slugiem: echo slugu w message', async () => {
    const { lookups } = fakeLookups(THREE);
    const err = await buildScopeError(
      { status: 'unresolved', reason: 'project_not_found', requestedSlug: 'nope-zzz' },
      lookups,
    );
    expect(err.message).toContain('No project with slug "nope-zzz" exists.');
  });

  it('project_pending: echo slugu oczekującej propozycji', async () => {
    const { lookups } = fakeLookups(THREE);
    const err = await buildScopeError(
      { status: 'unresolved', reason: 'project_pending', requestedSlug: 'new-one' },
      lookups,
    );
    expect(err.message).toContain('Project "new-one" is awaiting human approval');
  });
});

describe('buildScopeError — wskazówki o narzędziach konta (scope B)', () => {
  it('project_required / project_not_found kierują do list_projects / create_project', async () => {
    const { lookups } = fakeLookups(THREE);
    const required = await buildScopeError({ status: 'unresolved', reason: 'project_required' }, lookups);
    expect(required.message).toContain('list_projects');
    const notFound = await buildScopeError(
      { status: 'unresolved', reason: 'project_not_found', requestedSlug: 'nope-zzz' },
      lookups,
    );
    expect(notFound.message).toContain('create_project');
  });

  it('project_pending zakazuje ponownego create_project', async () => {
    const { lookups } = fakeLookups(THREE);
    const err = await buildScopeError(
      { status: 'unresolved', reason: 'project_pending', requestedSlug: 'new-one' },
      lookups,
    );
    expect(err.message).toContain('do not call create_project again');
  });

  it('project_forbidden nie wspomina narzędzi konta (token projektowy ich nie ma — anty-probing)', async () => {
    const { lookups } = fakeLookups(THREE);
    const err = await buildScopeError({ status: 'unresolved', reason: 'project_forbidden' }, lookups);
    expect(err.message).not.toMatch(/list_projects|create_project/);
  });

  it('zero projektów: komunikat sugeruje create_project', () => {
    expect(describeProjects([])).toContain('create_project');
  });
});
