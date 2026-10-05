import { describe, expect, it } from 'vitest';
import type { ProjectRow } from '../src/db/schema';
import {
  readProjectHeader,
  resolveProjectScope,
  type ProjectScopeLookups,
} from '../src/projects/project-scope';
import type { PublicTokenRow } from '../src/projects/projects.service';

const X: ProjectRow = {
  id: 'proj_x',
  name: 'X Project',
  slug: 'mcp-e2e',
  createdAt: new Date(0),
  includeEventsInDefaultSearch: false,
};
const Y: ProjectRow = { ...X, id: 'proj_y', name: 'Y Project', slug: 'mcp-e2e-y', includeEventsInDefaultSearch: true };

function token(projectId: string | null): PublicTokenRow {
  return {
    id: 'tok_1',
    projectId,
    label: 'agent-one',
    status: 'active',
    createdAt: new Date(0),
    graceStartedAt: null,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  };
}

/** Fałszywe lookupy z licznikami wywołań (anty-probing: token projektowy nie może dotykać bazy). */
function fakeLookups(opts: { projects?: ProjectRow[]; pending?: string[] } = {}) {
  const calls = { findBySlug: 0, isSlugPending: 0 };
  const lookups: ProjectScopeLookups = {
    async findBySlug(slug) {
      calls.findBySlug++;
      return (opts.projects ?? []).find((p) => p.slug === slug) ?? null;
    },
    async isSlugPending(slug) {
      calls.isSlugPending++;
      return (opts.pending ?? []).includes(slug);
    },
  };
  return { lookups, calls };
}

describe('readProjectHeader', () => {
  it('trim + lowercase, pusta/białe znaki -> undefined, tablica -> pierwsza wartość', () => {
    expect(readProjectHeader('My-Project ')).toBe('my-project');
    expect(readProjectHeader('')).toBeUndefined();
    expect(readProjectHeader('   ')).toBeUndefined();
    expect(readProjectHeader(undefined)).toBeUndefined();
    expect(readProjectHeader(['A-b', 'c'])).toBe('a-b');
  });
});

describe('resolveProjectScope — token projektowy', () => {
  it('bez nagłówka -> projekt tokena, kontekst z atrybucją tokena', async () => {
    const { lookups, calls } = fakeLookups();
    const res = await resolveProjectScope({ token: token('proj_x'), tokenProject: X, slug: undefined }, lookups);
    expect(res).toEqual({
      status: 'resolved',
      context: {
        projectId: 'proj_x',
        projectName: 'X Project',
        includeEventsInDefaultSearch: false,
        tokenId: 'tok_1',
        tokenLabel: 'agent-one',
      },
    });
    expect(calls).toEqual({ findBySlug: 0, isSlugPending: 0 });
  });

  it('nagłówek == własny slug -> projekt tokena', async () => {
    const { lookups, calls } = fakeLookups();
    const res = await resolveProjectScope({ token: token('proj_x'), tokenProject: X, slug: 'mcp-e2e' }, lookups);
    expect(res.status).toBe('resolved');
    expect(calls).toEqual({ findBySlug: 0, isSlugPending: 0 });
  });

  it('obcy nagłówek (istniejący ALBO nie) -> identyczny project_forbidden, zero zapytań, bez echa', async () => {
    const { lookups, calls } = fakeLookups({ projects: [X, Y], pending: ['pending-one'] });
    const existing = await resolveProjectScope({ token: token('proj_x'), tokenProject: X, slug: 'mcp-e2e-y' }, lookups);
    const missing = await resolveProjectScope({ token: token('proj_x'), tokenProject: X, slug: 'nope-zzz' }, lookups);
    const pending = await resolveProjectScope({ token: token('proj_x'), tokenProject: X, slug: 'pending-one' }, lookups);

    expect(existing).toEqual({ status: 'unresolved', reason: 'project_forbidden' });
    expect(missing).toEqual(existing);
    expect(pending).toEqual(existing);
    expect('requestedSlug' in existing).toBe(false);
    expect(calls).toEqual({ findBySlug: 0, isSlugPending: 0 });
  });
});

describe('resolveProjectScope — token konta', () => {
  it('bez nagłówka -> project_required (bez zapytań)', async () => {
    const { lookups, calls } = fakeLookups({ projects: [X] });
    const res = await resolveProjectScope({ token: token(null), tokenProject: null, slug: undefined }, lookups);
    expect(res).toEqual({ status: 'unresolved', reason: 'project_required' });
    expect(calls).toEqual({ findBySlug: 0, isSlugPending: 0 });
  });

  it('slug istniejącego projektu -> rozwiązany, kontekst niesie token konta (atrybucja)', async () => {
    const { lookups, calls } = fakeLookups({ projects: [X, Y] });
    const res = await resolveProjectScope({ token: token(null), tokenProject: null, slug: 'mcp-e2e-y' }, lookups);
    expect(res).toEqual({
      status: 'resolved',
      context: {
        projectId: 'proj_y',
        projectName: 'Y Project',
        includeEventsInDefaultSearch: true,
        tokenId: 'tok_1',
        tokenLabel: 'agent-one',
      },
    });
    expect(calls.isSlugPending).toBe(0); // trafienie w projekt nie sprawdza propozycji
  });

  it('wartość nagłówka po normalizacji ("MCP-E2E ") rozwiązuje się jak "mcp-e2e"', async () => {
    const { lookups } = fakeLookups({ projects: [X] });
    const res = await resolveProjectScope(
      { token: token(null), tokenProject: null, slug: readProjectHeader('MCP-E2E ') },
      lookups,
    );
    expect(res.status).toBe('resolved');
  });

  it('pudło w projekty + oczekująca propozycja -> project_pending (z requestedSlug)', async () => {
    const { lookups } = fakeLookups({ projects: [X], pending: ['new-one'] });
    const res = await resolveProjectScope({ token: token(null), tokenProject: null, slug: 'new-one' }, lookups);
    expect(res).toEqual({ status: 'unresolved', reason: 'project_pending', requestedSlug: 'new-one' });
  });

  it('nieznany slug -> project_not_found (z requestedSlug)', async () => {
    const { lookups, calls } = fakeLookups({ projects: [X] });
    const res = await resolveProjectScope({ token: token(null), tokenProject: null, slug: 'nope-zzz' }, lookups);
    expect(res).toEqual({ status: 'unresolved', reason: 'project_not_found', requestedSlug: 'nope-zzz' });
    expect(calls).toEqual({ findBySlug: 1, isSlugPending: 1 });
  });

  it('slug w złym formacie -> project_not_found bez zapytań i bez echa', async () => {
    const { lookups, calls } = fakeLookups({ projects: [X] });
    for (const bad of ['a', '-ab', 'a--b', 'has space', 'ąę', 'a'.repeat(49), "x'; DROP TABLE projects;--"]) {
      const res = await resolveProjectScope({ token: token(null), tokenProject: null, slug: bad }, lookups);
      expect(res, bad).toEqual({ status: 'unresolved', reason: 'project_not_found' });
    }
    expect(calls).toEqual({ findBySlug: 0, isSlugPending: 0 });
  });
});
