import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuditService } from '../src/audit/audit.service';
import type { ProjectRow } from '../src/db/schema';
import { DASHBOARD_ACTOR } from '../src/dashboard/dashboard.constants';
import { ProjectsController } from '../src/dashboard/projects.controller';
import type { ProjectsService } from '../src/projects/projects.service';
import type { UsageService } from '../src/usage/usage.service';

const NO_QUERY = {} as Record<string, never>;

function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 'proj_1',
    name: 'Projekt',
    slug: 'old-slug',
    includeEventsInDefaultSearch: false,
    autoMode: false,
    autoModeDailyLimit: 50,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as ProjectRow;
}

interface Logged {
  eventType: string;
  actor: string;
  metadata: Record<string, unknown>;
}

/** Fake serwisy — `ProjectsController.update` to cienki wrapper (audyt `project_settings_changed`
 * w kontrolerze, nie w serwisie). Test sprawdza WYŁĄCZNIE, co trafia do audytu (roadmap v1.5, scope C). */
function setup(opts: { current?: ProjectRow | null; afterSlug?: ProjectRow } = {}) {
  const current = opts.current === undefined ? projectRow() : opts.current;
  let state = opts.afterSlug ?? current; // "wiersz w bazie" — updateSlug/updateProject modyfikują go jak UPDATE
  const logged: Logged[] = [];
  const created: Array<{ name: string; options: unknown }> = [];
  const projects = {
    findById: async () => current,
    updateSlug: async (_id: string, slug: string) => {
      state = opts.afterSlug ?? { ...current!, slug };
      return state;
    },
    updateProject: async (
      _id: string,
      u: { includeEventsInDefaultSearch?: boolean; autoMode?: boolean; autoModeDailyLimit?: number },
    ) => {
      // jak UPDATE: pola `undefined` nie nadpisują wiersza
      state = {
        ...state!,
        ...(u.includeEventsInDefaultSearch !== undefined
          ? { includeEventsInDefaultSearch: u.includeEventsInDefaultSearch }
          : {}),
        ...(u.autoMode !== undefined ? { autoMode: u.autoMode } : {}),
        ...(u.autoModeDailyLimit !== undefined ? { autoModeDailyLimit: u.autoModeDailyLimit } : {}),
      };
      return state;
    },
    createProject: async (name: string, options: unknown) => {
      created.push({ name, options });
      return { project: projectRow(), token: 'ck_x', tokenRow: { id: 'tok_1', label: 'default' } };
    },
  } as unknown as ProjectsService;
  const audit = { log: async (e: Logged) => void logged.push(e) } as unknown as AuditService;
  const controller = new ProjectsController(projects, {} as UsageService, audit);
  return { controller, logged, created };
}

describe('ProjectsController.update — slug + audyt (roadmap v1.5, scope C)', () => {
  it('zmiana slugu loguje dokładnie jeden project_settings_changed z from/to', async () => {
    const { controller, logged } = setup();
    const result = await controller.update('proj_1', { slug: 'new-slug' }, NO_QUERY);
    expect(result.slug).toBe('new-slug');
    expect(logged).toEqual([
      {
        eventType: 'project_settings_changed',
        actor: DASHBOARD_ACTOR,
        metadata: { projectId: 'proj_1', field: 'slug', from: 'old-slug', to: 'new-slug' },
      },
    ]);
  });

  it('ten sam slug (no-op w serwisie) nie loguje nic', async () => {
    const { controller, logged } = setup({ afterSlug: projectRow({ slug: 'old-slug' }) });
    const result = await controller.update('proj_1', { slug: 'old-slug' }, NO_QUERY);
    expect(result.slug).toBe('old-slug');
    expect(logged).toEqual([]);
  });

  it('oba pola w jednym PATCH logują dwa wpisy (slug, potem includeEventsInDefaultSearch)', async () => {
    const { controller, logged } = setup();
    const result = await controller.update(
      'proj_1',
      { slug: 'new-slug', includeEventsInDefaultSearch: true },
      NO_QUERY,
    );
    expect(result).toMatchObject({ slug: 'new-slug', includeEventsInDefaultSearch: true });
    expect(logged.map((l) => l.metadata)).toEqual([
      { projectId: 'proj_1', field: 'slug', from: 'old-slug', to: 'new-slug' },
      { projectId: 'proj_1', field: 'includeEventsInDefaultSearch', from: false, to: true },
    ]);
  });

  it('samo includeEventsInDefaultSearch: jeden wpis, bez wpisu o slugu', async () => {
    const { controller, logged } = setup();
    await controller.update('proj_1', { includeEventsInDefaultSearch: true }, NO_QUERY);
    expect(logged).toHaveLength(1);
    expect(logged[0].metadata).toMatchObject({ field: 'includeEventsInDefaultSearch' });
  });

  it('włączenie auto mode loguje dokładnie jeden wpis {field:autoMode, from:false, to:true}', async () => {
    const { controller, logged } = setup();
    const result = await controller.update('proj_1', { autoMode: true }, NO_QUERY);
    expect(result.autoMode).toBe(true);
    expect(logged).toEqual([
      {
        eventType: 'project_settings_changed',
        actor: DASHBOARD_ACTOR,
        metadata: { projectId: 'proj_1', field: 'autoMode', from: false, to: true },
      },
    ]);
  });

  it('ta sama wartość autoMode / limitu nie loguje nic (brak realnej zmiany)', async () => {
    const { controller, logged } = setup();
    await controller.update('proj_1', { autoMode: false, autoModeDailyLimit: 50 }, NO_QUERY);
    expect(logged).toEqual([]);
  });

  it('zmiana limitu loguje {field:autoModeDailyLimit, from:50, to:10}', async () => {
    const { controller, logged } = setup();
    await controller.update('proj_1', { autoModeDailyLimit: 10 }, NO_QUERY);
    expect(logged.map((l) => l.metadata)).toEqual([
      { projectId: 'proj_1', field: 'autoModeDailyLimit', from: 50, to: 10 },
    ]);
  });

  it('wszystkie cztery pola w jednym PATCH: kolejność slug → includeEvents → autoMode → limit', async () => {
    const { controller, logged } = setup();
    await controller.update(
      'proj_1',
      { slug: 'new-slug', includeEventsInDefaultSearch: true, autoMode: true, autoModeDailyLimit: 7 },
      NO_QUERY,
    );
    expect(logged.map((l) => l.metadata.field)).toEqual([
      'slug',
      'includeEventsInDefaultSearch',
      'autoMode',
      'autoModeDailyLimit',
    ]);
  });

  it('nieznany projekt -> NotFoundException, bez audytu', async () => {
    const { controller, logged } = setup({ current: null });
    await expect(controller.update('proj_nope', { slug: 'x-y' }, NO_QUERY)).rejects.toBeInstanceOf(NotFoundException);
    expect(logged).toEqual([]);
  });
});

describe('ProjectsController.create — slug przekazany do serwisu (roadmap v1.5, scope C)', () => {
  it('przekazuje { label, slug } do createProject', async () => {
    const { controller, created } = setup();
    await controller.create({ name: 'Nowy', tokenLabel: 'ci', slug: 'nowy-slug' }, NO_QUERY);
    expect(created).toEqual([{ name: 'Nowy', options: { label: 'ci', slug: 'nowy-slug' } }]);
  });

  it('bez slugu przekazuje slug=undefined (slug z nazwy)', async () => {
    const { controller, created } = setup();
    await controller.create({ name: 'Nowy' }, NO_QUERY);
    expect(created[0].options).toEqual({ label: undefined, slug: undefined });
  });
});
