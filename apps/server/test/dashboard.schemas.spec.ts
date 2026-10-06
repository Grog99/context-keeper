import { describe, expect, it } from 'vitest';
import { encodeKeysetCursor } from '../src/common/keyset-cursor';
import {
  approveBody,
  auditListQuery,
  bulkApproveBody,
  createProjectBody,
  createRelationBody,
  editMemoryBody,
  emptyBody,
  emptyQuery,
  humanCreateBody,
  memoriesListQuery,
  memoryEventsQuery,
  opaqueId,
  proposalsListQuery,
  purgeBody,
  rejectBody,
  tokenLabelBody,
  updateProjectBody,
  usageQuery,
} from '../src/dashboard/dashboard.schemas';

describe('dashboard.schemas — happy paths kształtowane dokładnie jak SPA wysyła', () => {
  it('memoriesListQuery: scope/projectId/kind/tags[]/q — tags wielokrotny klucz zostaje tablicą', () => {
    const result = memoriesListQuery.parse({
      scope: 'project',
      projectId: 'proj_abc123def456',
      kind: 'fact',
      status: 'approved',
      tags: ['a', 'b'],
      q: 'szukane hasło',
    });
    expect(result.tags).toEqual(['a', 'b']);
  });

  it('memoriesListQuery: pojedynczy tag (?tags=a) -> string, transformowany do tablicy jednoelementowej', () => {
    const result = memoriesListQuery.parse({ tags: 'a' });
    expect(result.tags).toEqual(['a']);
  });

  it('memoriesListQuery: pusty obiekt (brak filtrów) jest poprawny — wszystko optional', () => {
    expect(memoriesListQuery.parse({})).toEqual({});
  });

  it('auditListQuery: from/to ISO, cursor keyset, limit cyfrowy -> Date/{ts,id}/number', () => {
    const pos = { ts: '2026-01-15T00:00:00.123456Z', id: 'evt_a1b2c3d4e5f6' };
    const result = auditListQuery.parse({
      eventType: 'human_edit',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      cursor: encodeKeysetCursor(pos),
      limit: '250',
    });
    expect(result.from).toBeInstanceOf(Date);
    expect(result.to).toBeInstanceOf(Date);
    expect(result.limit).toBe(250);
    expect(result.cursor).toEqual(pos); // cursor docieka do serwisu zdekodowany
  });

  it('auditListQuery.cursor: stary ISO i śmieci -> invalid (nightly-scale G6)', () => {
    for (const cursor of ['2026-01-15T00:00:00.000Z', 'garbage', 'A'.repeat(300)]) {
      expect(auditListQuery.safeParse({ cursor }).success).toBe(false);
    }
  });

  it('usageQuery: bucket=hour, from/to ISO', () => {
    const result = usageQuery.parse({ bucket: 'hour', from: '2026-01-01T00:00:00.000Z' });
    expect(result.bucket).toBe('hour');
    expect(result.from).toBeInstanceOf(Date);
  });

  it('proposalsListQuery: status/origin/type/scope=global', () => {
    const result = proposalsListQuery.parse({ status: 'pending', origin: 'agent', type: 'create', scope: 'global' });
    expect(result).toEqual({ status: 'pending', origin: 'agent', type: 'create', scope: 'global' });
  });

  it('proposalsListQuery: limit (cyfrowy 1..500) i cursor keyset', () => {
    const pos = { ts: '2026-01-15T00:00:00.123456Z', id: 'prop_a1b2c3d4e5f6' };
    const result = proposalsListQuery.parse({ limit: '100', cursor: encodeKeysetCursor(pos) });
    expect(result).toEqual({ limit: 100, cursor: pos });
    expect(proposalsListQuery.safeParse({ limit: '500' }).success).toBe(true);
  });

  it('createRelationBody: {toId, type} jak wysyła RelationsPanel/MemoryBrowserScreen', () => {
    expect(createRelationBody.parse({ toId: 'mem_abc123def456', type: 'follows' })).toEqual({
      toId: 'mem_abc123def456',
      type: 'follows',
    });
  });

  it('humanCreateBody: kształt HumanCreateDialog (projectId/eventTime pominięte dla scope=global/kind!=event)', () => {
    const result = humanCreateBody.parse({
      kind: 'fact',
      header: 'Nagłówek',
      body: 'Treść',
      tags: ['a', 'b'],
      scope: 'global',
    });
    expect(result.projectId).toBeUndefined();
    expect(result.eventTime).toBeUndefined();
  });

  it('editMemoryBody: wszystkie pola opcjonalne, {} przechodzi (no-op edit)', () => {
    expect(editMemoryBody.parse({})).toEqual({});
  });

  it('purgeBody: {reason} jak PurgeMemoryDialog', () => {
    expect(purgeBody.parse({ reason: 'AWS key w body' })).toEqual({ reason: 'AWS key w body' });
  });

  it('createProjectBody: name jest trimowany', () => {
    expect(createProjectBody.parse({ name: '  Projekt X  ' }).name).toBe('Projekt X');
  });

  it('updateProjectBody: {includeEventsInDefaultSearch: boolean} jak ProjectSettingsDialog', () => {
    expect(updateProjectBody.parse({ includeEventsInDefaultSearch: true })).toEqual({
      includeEventsInDefaultSearch: true,
    });
  });

  it('updateProjectBody: {slug} (v1.5, edycja slugu w ProjectSettingsDialog) i oba pola naraz', () => {
    expect(updateProjectBody.parse({ slug: 'My-Slug' })).toEqual({ slug: 'My-Slug' });
    expect(updateProjectBody.parse({ slug: 'x', includeEventsInDefaultSearch: false })).toEqual({
      slug: 'x',
      includeEventsInDefaultSearch: false,
    });
  });

  it('createProjectBody: opcjonalny slug (v1.5) — kształt, nie format', () => {
    expect(createProjectBody.parse({ name: 'X', slug: 'Bad_Slug' })).toEqual({ name: 'X', slug: 'Bad_Slug' });
  });

  it('tokenLabelBody: {label} jak ProjectTokensDialog create/rename', () => {
    expect(tokenLabelBody.parse({ label: 'agent-two' })).toEqual({ label: 'agent-two' });
  });

  it('emptyQuery/emptyBody: {} przechodzi; emptyBody akceptuje też undefined (SPA bodiless POST)', () => {
    expect(emptyQuery.parse({})).toEqual({});
    expect(emptyBody.parse(undefined)).toEqual({});
    expect(emptyBody.parse({})).toEqual({});
  });

  it('memoryEventsQuery: {} i {scope, projectId} poprawne', () => {
    expect(memoryEventsQuery.parse({})).toEqual({});
    expect(memoryEventsQuery.parse({ scope: 'project', projectId: 'proj_abc123def456' })).toEqual({
      scope: 'project',
      projectId: 'proj_abc123def456',
    });
  });

  it('bulkApproveBody: {ids: string[]} jak QueueScreen', () => {
    expect(bulkApproveBody.parse({ ids: ['prop_1', 'prop_2'] })).toEqual({ ids: ['prop_1', 'prop_2'] });
  });

  it('opaqueId: akceptuje generateId() output ORAZ legacy tok_<md5hex>', () => {
    expect(opaqueId.safeParse('mem_a1b2c3d4e5f6').success).toBe(true);
    expect(opaqueId.safeParse('tok_' + 'a'.repeat(12)).success).toBe(true);
  });
});

describe('dashboard.schemas — bad enum wartości -> 400 (safeParse.success === false)', () => {
  const badEnumCases: Array<{ name: string; schema: { safeParse: (v: unknown) => { success: boolean } }; value: unknown }> = [
    { name: 'memoriesListQuery.kind=bogus', schema: memoriesListQuery, value: { kind: 'bogus' } },
    { name: 'memoriesListQuery.status=bogus', schema: memoriesListQuery, value: { status: 'bogus' } },
    { name: 'memoriesListQuery.scope=bogus', schema: memoriesListQuery, value: { scope: 'bogus' } },
    { name: 'auditListQuery.eventType=nope', schema: auditListQuery, value: { eventType: 'nope' } },
    { name: 'usageQuery.bucket=week', schema: usageQuery, value: { bucket: 'week' } },
    { name: 'proposalsListQuery.status=bogus', schema: proposalsListQuery, value: { status: 'bogus' } },
    { name: 'createRelationBody.type=bogus', schema: createRelationBody, value: { toId: 'mem_1', type: 'bogus' } },
  ];

  for (const { name, schema, value } of badEnumCases) {
    it(`${name} -> invalid`, () => {
      expect(schema.safeParse(value).success).toBe(false);
    });
  }
});

describe('dashboard.schemas — limitQuery (via auditListQuery.limit)', () => {
  const badLimits = ['abc', '0', '501', '5.5', '1e2', '0x10', ''];
  for (const limit of badLimits) {
    it(`limit="${limit}" -> invalid`, () => {
      expect(auditListQuery.safeParse({ limit }).success).toBe(false);
    });
  }

  it('limit="500" (max) -> valid, "1" (min) -> valid', () => {
    expect(auditListQuery.safeParse({ limit: '500' }).success).toBe(true);
    expect(auditListQuery.safeParse({ limit: '1' }).success).toBe(true);
  });
});

describe('dashboard.schemas — proposalsListQuery.limit/cursor złe -> 400', () => {
  for (const limit of ['abc', '0', '501', '5.5', '1e2', '']) {
    it(`limit="${limit}" -> invalid`, () => {
      expect(proposalsListQuery.safeParse({ limit }).success).toBe(false);
    });
  }

  for (const cursor of ['garbage', '2026-01-15T00:00:00.000Z', '']) {
    it(`cursor="${cursor}" -> invalid`, () => {
      expect(proposalsListQuery.safeParse({ cursor }).success).toBe(false);
    });
  }
});

describe('dashboard.schemas — daty złe -> 400', () => {
  const badDates = ['wczoraj', '2026-13-01T00:00:00Z', '2026-01-01', 'not-a-date'];
  for (const value of badDates) {
    it(`auditListQuery.from="${value}" -> invalid`, () => {
      expect(auditListQuery.safeParse({ from: value }).success).toBe(false);
    });
  }

  it('auditListQuery.from ISO poprawny -> valid', () => {
    expect(auditListQuery.safeParse({ from: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
  });
});

describe('dashboard.schemas — strict: nieznany klucz -> 400', () => {
  it('memoriesListQuery odrzuca nieznany klucz', () => {
    expect(memoriesListQuery.safeParse({ foo: 'bar' }).success).toBe(false);
  });

  it('emptyQuery odrzuca KAŻDY klucz', () => {
    expect(emptyQuery.safeParse({ foo: 'bar' }).success).toBe(false);
    expect(emptyQuery.safeParse({}).success).toBe(true);
  });

  it('emptyBody odrzuca każdy klucz, ale przyjmuje undefined/{}', () => {
    expect(emptyBody.safeParse({ x: 1 }).success).toBe(false);
    expect(emptyBody.safeParse(undefined).success).toBe(true);
    expect(emptyBody.safeParse({}).success).toBe(true);
  });

  it('humanCreateBody odrzuca nieznany klucz (np. "extra")', () => {
    expect(
      humanCreateBody.safeParse({
        kind: 'fact',
        header: 'H',
        body: 'B',
        scope: 'global',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('dashboard.schemas — body: brakujące wymagane pole / zły typ / undefined', () => {
  it('createRelationBody: brak toId -> invalid', () => {
    expect(createRelationBody.safeParse({ type: 'follows' }).success).toBe(false);
  });

  it('purgeBody: brak reason -> invalid; undefined body -> invalid (reason wymagany, NIE optionalBody)', () => {
    expect(purgeBody.safeParse({}).success).toBe(false);
    expect(purgeBody.safeParse(undefined).success).toBe(false);
  });

  it('updateProjectBody: includeEventsInDefaultSearch="true" (string, nie boolean) -> invalid', () => {
    expect(updateProjectBody.safeParse({ includeEventsInDefaultSearch: 'true' }).success).toBe(false);
  });

  it('updateProjectBody: slug nie-string / za długi / nieznany klucz -> invalid', () => {
    expect(updateProjectBody.safeParse({ slug: 1 }).success).toBe(false);
    expect(updateProjectBody.safeParse({ slug: 'x'.repeat(201) }).success).toBe(false);
    expect(updateProjectBody.safeParse({ slug: 'x', extra: true }).success).toBe(false);
  });

  it('createProjectBody: slug nie-string -> invalid', () => {
    expect(createProjectBody.safeParse({ name: 'X', slug: 5 }).success).toBe(false);
  });

  it('createProjectBody: tab / CR / LF w nazwie -> invalid (kontrakt TSV list-projects); zwykła spacja OK', () => {
    expect(createProjectBody.safeParse({ name: 'a\tb' }).success).toBe(false);
    expect(createProjectBody.safeParse({ name: 'a\nb' }).success).toBe(false);
    expect(createProjectBody.safeParse({ name: 'a\rb' }).success).toBe(false);
    expect(createProjectBody.safeParse({ name: 'a b' }).success).toBe(true);
    // tab/CR/LF na brzegach zjada .trim() przed regexem — wynik nie zawiera znaków sterujących
    expect(createProjectBody.parse({ name: '\tProjekt\n' }).name).toBe('Projekt');
  });

  it('bulkApproveBody: undefined body -> invalid (ids wymagane)', () => {
    expect(bulkApproveBody.safeParse(undefined).success).toBe(false);
  });

  it('approveBody/rejectBody: optionalBody wzorzec — undefined -> {} -> valid', () => {
    expect(approveBody.safeParse(undefined).success).toBe(true);
    expect(approveBody.safeParse({}).success).toBe(true);
    expect(approveBody.safeParse({ supersedes: 'mem_1' }).success).toBe(true);
    expect(approveBody.safeParse({ expectedSupersedeVersion: -1 }).success).toBe(false);
    expect(rejectBody.safeParse(undefined).success).toBe(true);
    expect(rejectBody.safeParse({ reason: 'dup' }).success).toBe(true);
  });
});
