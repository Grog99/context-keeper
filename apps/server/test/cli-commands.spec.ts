import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CreateAccountTokenCommand } from '../src/cli/create-account-token.command';
import { CreateProjectCommand } from '../src/cli/create-project.command';
import { ListAccountTokensCommand } from '../src/cli/list-account-tokens.command';
import { ListProjectsCommand } from '../src/cli/list-projects.command';
import type { ProjectRow } from '../src/db/schema';
import type { ProjectsService, PublicTokenRow } from '../src/projects/projects.service';

/**
 * Komendy CLI dotknięte w roadmap v1.5 (scope C) na fake `ProjectsService` + spy na `console.log` —
 * bez bazy i bez uruchamiania nest-commander. `install.sh` parsuje `list-projects` po polu 3 (nazwa),
 * więc ten kontrakt jest przypięty tu wprost (predykat `awk -F'\t' '$3==want'` odtworzony w JS).
 */

let logSpy: MockInstance<typeof console.log>;
let lines: string[];

beforeEach(() => {
  lines = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

function project(overrides: Partial<ProjectRow>): ProjectRow {
  return {
    id: 'proj_1',
    name: 'Projekt',
    slug: 'projekt',
    includeEventsInDefaultSearch: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as ProjectRow;
}

function tokenRow(overrides: Partial<PublicTokenRow>): PublicTokenRow {
  return {
    id: 'tok_1',
    projectId: null,
    label: 'laptop',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    graceStartedAt: null,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

describe('list-projects — kontrakt TSV dla install.sh (pole 3 = nazwa, SLUG na końcu)', () => {
  it('nagłówek ID TOKENS NAZWA SLUG; pole 3 = nazwa, pole 4 = slug', async () => {
    const projects = {
      listProjects: async () => [
        project({ id: 'proj_a', name: 'Moje Repo', slug: 'moje-repo' }),
        project({ id: 'proj_b', name: 'Drugie', slug: 'drugie' }),
      ],
      countTokensByProject: async () => new Map([['proj_a', { active: 2, grace: 1, revoked: 0 }]]),
    } as unknown as ProjectsService;

    await new ListProjectsCommand(projects).run();

    expect(lines[0]).toBe('ID\tTOKENS\tNAZWA\tSLUG');
    const rows = lines.slice(1).map((l) => l.split('\t'));
    expect(rows[0]).toEqual(['proj_a', 'tokens:2/1', 'Moje Repo', 'moje-repo']);
    // projekt bez tokenów (approve create_project) — 0/0, nic nie zakłada ≥1 tokena
    expect(rows[1]).toEqual(['proj_b', 'tokens:0/0', 'Drugie', 'drugie']);
  });

  it('predykat install.sh (`$3==want`) nadal znajduje projekt po nazwie i zwraca jego id z pola 1', async () => {
    const projects = {
      listProjects: async () => [project({ id: 'proj_a', name: 'Moje Repo', slug: 'moje-repo' })],
      countTokensByProject: async () => new Map(),
    } as unknown as ProjectsService;

    await new ListProjectsCommand(projects).run();

    const want = 'Moje Repo';
    const match = lines.find((line) => line.split('\t')[2] === want);
    expect(match?.split('\t')[0]).toBe('proj_a');
    // nazwa projektu nie jest mylona ze slugiem (pole 4)
    expect(lines.find((line) => line.split('\t')[2] === 'moje-repo')).toBeUndefined();
  });

  it('brak projektów -> komunikat o create-project', async () => {
    const projects = {
      listProjects: async () => [],
      countTokensByProject: async () => new Map(),
    } as unknown as ProjectsService;
    await new ListProjectsCommand(projects).run();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('create-project');
  });
});

describe('create-project --slug (roadmap v1.5, scope C)', () => {
  function fakeCreate() {
    const calls: Array<{ name: string; opts: unknown }> = [];
    const projects = {
      createProject: async (name: string, opts: unknown) => {
        calls.push({ name, opts });
        return {
          project: project({ name }),
          token: 'ck_createprojecttoken',
          tokenRow: tokenRow({ projectId: 'proj_1', label: 'default' }),
        };
      },
    } as unknown as ProjectsService;
    return { calls, projects };
  }

  it('z --slug: przekazuje { label, slug } do createProject', async () => {
    const { calls, projects } = fakeCreate();
    await new CreateProjectCommand(projects).run(['Nowy projekt', 'ci'], { slug: ' moj-slug ' });
    expect(calls).toEqual([{ name: 'Nowy projekt', opts: { label: 'ci', slug: 'moj-slug' } }]);
    expect(lines.join('\n')).toContain('ck_createprojecttoken');
  });

  it('bez --slug: slug=undefined (wyprowadzany z nazwy) — zachowanie jak dla install.sh', async () => {
    const { calls, projects } = fakeCreate();
    await new CreateProjectCommand(projects).run(['Nowy projekt'], {});
    expect(calls).toEqual([{ name: 'Nowy projekt', opts: { label: undefined, slug: undefined } }]);
  });

  it('błąd serwisu (zajęty / nieprawidłowy slug) propaguje się z komunikatem po polsku', async () => {
    const projects = {
      createProject: async () => {
        throw new Error('Slug "x" jest już zajęty przez istniejący projekt.');
      },
    } as unknown as ProjectsService;
    await expect(new CreateProjectCommand(projects).run(['P'], { slug: 'x' })).rejects.toThrow(/zajęty/);
  });

  it('flaga --slug jest zarejestrowana i zwraca wartość bez zmian', () => {
    expect(new CreateProjectCommand({} as ProjectsService).parseSlug('abc')).toBe('abc');
  });
});

describe('create-account-token', () => {
  it('woła createAccountToken z przyciętą etykietą i drukuje token dokładnie raz', async () => {
    let received: string | undefined;
    const projects = {
      createAccountToken: async (label: string) => {
        received = label;
        return { token: 'ck_accounttokenplaintext', tokenRow: tokenRow({ label }) };
      },
    } as unknown as ProjectsService;

    await new CreateAccountTokenCommand(projects).run(['  laptop  ']);

    expect(received).toBe('laptop');
    const output = lines.join('\n');
    expect(output.split('ck_accounttokenplaintext')).toHaveLength(2); // dokładnie jedno wystąpienie
    expect(output).toContain('Token konta utworzony');
    expect(output).toContain('Etykieta tokena:  laptop');
    expect(output).toContain('CONTEXT_KEEPER_TOKEN=<token>');
    expect(output).toContain('WSZYSTKICH projektach');
  });

  it('brak etykiety -> błąd z użyciem, serwis niewołany', async () => {
    const createAccountToken = vi.fn();
    const projects = { createAccountToken } as unknown as ProjectsService;
    await expect(new CreateAccountTokenCommand(projects).run(['   '])).rejects.toThrow(/create-account-token <label>/);
    expect(createAccountToken).not.toHaveBeenCalled();
  });
});

describe('list-account-tokens', () => {
  it('4 kolumny TOKEN_ID/STATUS/ETYKIETA/WYGASA, bez wartości tokena', async () => {
    const projects = {
      listAccountTokens: async () => [
        tokenRow({ id: 'tok_a', label: 'laptop' }),
        tokenRow({ id: 'tok_b', label: 'old', status: 'revoked', revokedAt: new Date('2026-02-01T00:00:00Z') }),
        tokenRow({
          id: 'tok_c',
          label: 'rotating',
          status: 'grace',
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      ],
    } as unknown as ProjectsService;

    await new ListAccountTokensCommand(projects).run();

    expect(lines[0]).toBe('TOKEN_ID\tSTATUS\tETYKIETA\tWYGASA');
    const rows = lines.slice(1).map((l) => l.split('\t'));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toHaveLength(4);
    expect(rows[0]).toEqual(['tok_a', 'active', 'laptop', '—']);
    expect(rows[1][1]).toBe('revoked');
    expect(rows[2][1]).toBe('grace');
    expect(rows[2][3]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines.join('\n')).not.toMatch(/ck_/);
  });

  it('brak tokenów konta -> wskazówka create-account-token', async () => {
    const projects = { listAccountTokens: async () => [] } as unknown as ProjectsService;
    await new ListAccountTokensCommand(projects).run();
    expect(lines).toEqual(['Brak tokenów konta. Utwórz: create-account-token <label>']);
  });
});
