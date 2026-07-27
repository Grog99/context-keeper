import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_ACTOR } from '../src/dashboard/dashboard.constants';
import { MemoriesController } from '../src/dashboard/memories.controller';
import type { CreateRelationInput, MemoryAdminService, RelationListItem } from '../src/memory/memory-admin.service';
import type { PurgeOptions, PurgePreview, PurgeResult, PurgeService } from '../src/purge/purge.service';

const PREVIEW: PurgePreview = {
  id: 'mem_1',
  status: 'approved',
  header: 'Seed header',
  embeddingsCount: 1,
  relatedProposalsCount: 2,
  revisionsWithContentCount: 3,
  relationsCount: 0,
};

const RESULT: PurgeResult = {
  id: 'mem_1',
  embeddingsDeleted: 1,
  stagingEmbeddingsDeleted: 0,
  proposalsRedacted: 2,
  revisionsRedacted: 1,
  relationsDeleted: 0,
};

/** `MemoryAdminService` nie jest wołany przez żaden test tego pliku (WYŁĄCZNIE endpointy hard-purge
 * dołożone w roadmap v1.1) — pusty stub, żeby konstruktor kontrolera się skompilował. */
function unusedMemoryAdmin(): MemoryAdminService {
  return {} as unknown as MemoryAdminService;
}

const RELATION_LIST: RelationListItem[] = [
  {
    id: 'rel_1',
    type: 'follows',
    direction: 'outgoing',
    source: 'human',
    createdAt: '2026-01-01T00:00:00.000Z',
    neighbor: { id: 'mem_2', header: 'Sasiad', kind: 'fact', status: 'approved' },
  },
];

/** Roadmap v1.2 ("memory-relations + 1-hop graph boost") — fake `MemoryAdminService` dla trzech
 * cienkich routy `:id/relations*` (mirror `fakePurge` powyżej): test sprawdza WYŁĄCZNIE przekazywane
 * argumenty i passthrough wyniku, kontroler jest cienkim wrapperem, bez dotykania bazy. */
function fakeMemoryAdmin(opts: {
  listRelations?: (id: string) => Promise<RelationListItem[]>;
  createRelation?: (input: CreateRelationInput) => Promise<{ id: string }>;
  removeRelation?: (relationId: string) => Promise<void>;
}): MemoryAdminService {
  return {
    listRelations: opts.listRelations ?? (async () => RELATION_LIST),
    createRelation: opts.createRelation ?? (async () => ({ id: 'rel_new' })),
    removeRelation: opts.removeRelation ?? (async () => undefined),
  } as unknown as MemoryAdminService;
}

/** Fake `PurgeService` — kontroler jest cienkim wrapperem (jak `NightlyController`), test sprawdza
 * WYŁĄCZNIE przekazywane argumenty i passthrough wyniku, bez dotykania bazy. */
function fakePurge(opts: {
  preview?: PurgePreview;
  result?: PurgeResult;
  captureOptions?: (id: string, options: PurgeOptions) => void;
}): PurgeService {
  return {
    preview: async () => opts.preview ?? PREVIEW,
    purge: async (id: string, options: PurgeOptions) => {
      opts.captureOptions?.(id, options);
      return opts.result ?? RESULT;
    },
  } as unknown as PurgeService;
}

describe('MemoriesController — hard-purge endpoints (roadmap v1.1)', () => {
  it('GET :id/purge-preview zwraca PurgePreview zwrócony przez serwis bez transformacji', async () => {
    const controller = new MemoriesController(unusedMemoryAdmin(), fakePurge({ preview: PREVIEW }));

    const result = await controller.purgePreview('mem_1');

    expect(result).toBe(PREVIEW);
  });

  it('POST :id/purge przekazuje { reason, actor: DASHBOARD_ACTOR } do PurgeService.purge()', async () => {
    let captured: { id: string; options: PurgeOptions } | undefined;
    const controller = new MemoriesController(
      unusedMemoryAdmin(),
      fakePurge({
        result: RESULT,
        captureOptions: (id, options) => (captured = { id, options }),
      }),
    );

    const result = await controller.purge('mem_1', { reason: 'AWS key w body' });

    expect(captured).toEqual({
      id: 'mem_1',
      options: { reason: 'AWS key w body', actor: DASHBOARD_ACTOR },
    });
    expect(result).toBe(RESULT);
  });

  it('POST :id/purge z brakującym body traktuje reason jako pusty string (walidację robi PurgeService)', async () => {
    let captured: PurgeOptions | undefined;
    const controller = new MemoriesController(
      unusedMemoryAdmin(),
      fakePurge({ captureOptions: (_id, options) => (captured = options) }),
    );

    await controller.purge('mem_1', undefined as unknown as { reason: string });

    expect(captured).toEqual({ reason: '', actor: DASHBOARD_ACTOR });
  });
});

describe('MemoriesController — relations endpoints (roadmap v1.2, "memory-relations + 1-hop graph boost")', () => {
  it('GET :id/relations woła memoryAdmin.listRelations(id) i zwraca wynik bez transformacji', async () => {
    let captured: string | undefined;
    const controller = new MemoriesController(
      fakeMemoryAdmin({
        listRelations: async (id) => {
          captured = id;
          return RELATION_LIST;
        },
      }),
      fakePurge({}),
    );

    const result = await controller.listRelations('mem_1');

    expect(captured).toBe('mem_1');
    expect(result).toBe(RELATION_LIST);
  });

  it('POST :id/relations przekazuje {fromId: id z URL, toId/type z body} do memoryAdmin.createRelation', async () => {
    let captured: CreateRelationInput | undefined;
    const controller = new MemoriesController(
      fakeMemoryAdmin({
        createRelation: async (input) => {
          captured = input;
          return { id: 'rel_created' };
        },
      }),
      fakePurge({}),
    );

    const result = await controller.createRelation('mem_1', { toId: 'mem_2', type: 'caused_by' });

    expect(captured).toEqual({ fromId: 'mem_1', toId: 'mem_2', type: 'caused_by' });
    expect(result).toEqual({ id: 'rel_created' });
  });

  it('POST :id/relations z nieznanym type odrzuca PRZED wejściem w serwis jako ToolError(validation_error)', async () => {
    let called = false;
    const controller = new MemoriesController(
      fakeMemoryAdmin({
        createRelation: async (_input) => {
          called = true;
          return { id: 'rel_created' };
        },
      }),
      fakePurge({}),
    );

    await expect(
      controller.createRelation('mem_1', { toId: 'mem_2', type: 'bogus' as unknown as CreateRelationInput['type'] }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(called).toBe(false);
  });

  it('POST :id/relations z brakującym toId odrzuca PRZED wejściem w serwis jako ToolError(validation_error)', async () => {
    let called = false;
    const controller = new MemoriesController(
      fakeMemoryAdmin({
        createRelation: async (_input) => {
          called = true;
          return { id: 'rel_created' };
        },
      }),
      fakePurge({}),
    );

    await expect(
      controller.createRelation('mem_1', { toId: undefined as unknown as string, type: 'caused_by' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(called).toBe(false);
  });

  it('DELETE :id/relations/:relationId woła memoryAdmin.removeRelation(relationId) i zwraca {ok:true}', async () => {
    let captured: string | undefined;
    const controller = new MemoriesController(
      fakeMemoryAdmin({
        removeRelation: async (relationId) => {
          captured = relationId;
        },
      }),
      fakePurge({}),
    );

    const result = await controller.removeRelation('rel_1');

    expect(captured).toBe('rel_1');
    expect(result).toEqual({ ok: true });
  });

  it('trasy relations są zadeklarowane pod :id/relations[...] — segmentowo różne od gołego :id, więc Express/Nest NIGDY nie mogą ich pomylić z GET :id, bez względu na kolejność rejestracji', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MemoriesController.prototype.listRelations)).toBe(':id/relations');
    expect(Reflect.getMetadata(METHOD_METADATA, MemoriesController.prototype.listRelations)).toBe(0); // GET

    expect(Reflect.getMetadata(PATH_METADATA, MemoriesController.prototype.createRelation)).toBe(':id/relations');
    expect(Reflect.getMetadata(METHOD_METADATA, MemoriesController.prototype.createRelation)).toBe(1); // POST

    expect(Reflect.getMetadata(PATH_METADATA, MemoriesController.prototype.removeRelation)).toBe(
      ':id/relations/:relationId',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, MemoriesController.prototype.removeRelation)).toBe(3); // DELETE
  });
});
