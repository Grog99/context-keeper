import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CheckLlmCommand } from '../src/cli/check-llm.command';
import { CreateAccountTokenCommand } from '../src/cli/create-account-token.command';
import { CreateProjectCommand } from '../src/cli/create-project.command';
import { ListAccountTokensCommand } from '../src/cli/list-account-tokens.command';
import { ListProjectsCommand } from '../src/cli/list-projects.command';
import { RunNightlyCommand } from '../src/cli/run-nightly.command';
import type { ProjectRow } from '../src/db/schema';
import type { LlmService } from '../src/llm/llm.service';
import type { LlmCheckResult } from '../src/llm/llm.types';
import type { NightlyService } from '../src/nightly/nightly.service';
import type { NightlyRunResult } from '../src/nightly/nightly.types';
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

describe('check-llm (roadmap v1.6, G2)', () => {
  const SENTINEL = 'sk-sentinel-DO-NOT-LEAK-cli-1';
  let errorSpy: MockInstance<typeof console.error>;
  let errors: string[];

  beforeEach(() => {
    errors = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  const llmReturning = (result: LlmCheckResult): LlmService =>
    ({ checkConnection: async () => result }) as unknown as LlmService;

  it('OK: drukuje model, latencję i endpoint (bez klucza)', async () => {
    await new CheckLlmCommand(
      llmReturning({ ok: true, model: 'gpt-real', latencyMs: 412, endpoint: 'https://a/v1/chat/completions', enabled: true }),
    ).run();

    expect(lines).toEqual(['[check-llm] OK model=gpt-real latencyMs=412 endpoint=https://a/v1/chat/completions']);
    expect(errors).toEqual([]);
  });

  it('OK przy wyłączonym kroku: dopisek o wyłączeniu w Ustawieniach', async () => {
    await new CheckLlmCommand(
      llmReturning({ ok: true, model: 'm', latencyMs: 1, endpoint: 'http://localhost:11434/v1/chat/completions', enabled: false }),
    ).run();
    expect(lines[0]).toContain('(krok wyłączony w Ustawieniach)');
  });

  it('błąd: czytelny komunikat na stderr, bez klucza', async () => {
    await new CheckLlmCommand(llmReturning({ ok: false, error: 'HTTP 401 — sprawdź klucz API.' })).run();

    expect(errors).toEqual(['[check-llm] BŁĄD — HTTP 401 — sprawdź klucz API.']);
    expect(lines).toEqual([]);
    expect(errors.join('\n')).not.toContain(SENTINEL);
  });

  it('nieoczekiwany wyjątek serwisu: złapany, komunikat stały (nie niesie message wyjątku)', async () => {
    const llm = {
      checkConnection: async () => {
        throw new Error(`boom ${SENTINEL}`);
      },
    } as unknown as LlmService;

    await new CheckLlmCommand(llm).run();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[check-llm] BŁĄD');
    expect(errors.join('\n')).not.toContain(SENTINEL);
  });
});

describe('run-nightly — podsumowanie niesie stan i liczniki kroku LLM (roadmap v1.6)', () => {
  const RESULT: NightlyRunResult = {
    status: 'success',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    counters: {
      created: 2,
      withdrawn: 1,
      skippedAsDup: 0,
      mergeProposed: 1,
      pruneProposed: 1,
      skippedPoliteness: 0,
      skippedCap: 0,
      searchEventsPruned: 4,
      llmCalls: 9,
      llmErrors: 2,
      llmSkippedCap: 3,
      llmSkippedBreaker: 4,
      llmSkippedSecret: 5,
      llmSkippedKeyUnreadable: 6,
      llmPruneCandidates: 7,
      llmPruneKept: 4,
      llmPruneDeleteProposed: 2,
      llmPruneUpdateProposed: 1,
    },
    llm: { state: 'ready', skippedSecret: [] },
  };

  const nightlyReturning = (result: NightlyRunResult): NightlyService =>
    ({ run: async () => result }) as unknown as NightlyService;

  it('linia podsumowania zawiera llm=<stan>, llmCalls, llmErrors, llmSkipped=cap/breaker/secret/key i searchEventsPruned', async () => {
    await new RunNightlyCommand(nightlyReturning(RESULT)).run([], {});

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('status=success');
    expect(lines[0]).toContain('searchEventsPruned=4');
    expect(lines[0]).toContain('llm=ready llmCalls=9 llmErrors=2 llmSkipped=cap:3,breaker:4,secret:5,key:6');
    expect(lines[0]).toContain('llmPrune=cand:7,kept:4,delete:2,update:1');
  });

  it('skipped-locked (llm:null) -> llm=- (przebieg się nie odbył)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      await new RunNightlyCommand(nightlyReturning({ ...RESULT, status: 'skipped-locked', llm: null })).run([], {});
    } finally {
      warnSpy.mockRestore();
    }
    expect(lines[0]).toContain('status=skipped-locked');
    expect(lines[0]).toContain('llm=- ');
  });
});
