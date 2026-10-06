import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/common/errors';
import { getReadScope, searchReadScope } from '../src/mcp/read-scope-policy';
import { isReadable, readScopeCondition } from '../src/memory/read-scope';

describe('searchReadScope — polityka token + all_projects (roadmap v1.5, G3)', () => {
  it('token konta + true -> all_projects', () => {
    expect(searchReadScope('account', true)).toBe('all_projects');
  });

  it('token konta + false -> project (jak dziś)', () => {
    expect(searchReadScope('account', false)).toBe('project');
  });

  it('token projektowy + false -> project (jak dziś)', () => {
    expect(searchReadScope('project', false)).toBe('project');
  });

  it('token projektowy + true -> validation_error z komunikatem o tokenie konta', () => {
    let thrown: unknown;
    try {
      searchReadScope('project', true);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).code).toBe('validation_error');
    expect((thrown as ToolError).message).toContain('account token');
  });
});

describe('getReadScope — get_memory (G6)', () => {
  it('token konta czyta każdy projekt, projektowy tylko własny', () => {
    expect(getReadScope('account')).toBe('all_projects');
    expect(getReadScope('project')).toBe('project');
  });
});

describe('isReadable — tabela prawdy zakresu odczytu', () => {
  const CURRENT = 'proj_current';
  const FOREIGN = 'proj_foreign';
  const globalRow = { scope: 'global', projectId: null } as const;
  const ownRow = { scope: 'project', projectId: CURRENT } as const;
  const foreignRow = { scope: 'project', projectId: FOREIGN } as const;

  it('scope=project: global i własny projekt tak, obcy projekt nie', () => {
    expect(isReadable(globalRow, 'project', CURRENT)).toBe(true);
    expect(isReadable(ownRow, 'project', CURRENT)).toBe(true);
    expect(isReadable(foreignRow, 'project', CURRENT)).toBe(false);
  });

  it('scope=all_projects: global, własny i obcy projekt — wszystko tak', () => {
    expect(isReadable(globalRow, 'all_projects', CURRENT)).toBe(true);
    expect(isReadable(ownRow, 'all_projects', CURRENT)).toBe(true);
    expect(isReadable(foreignRow, 'all_projects', CURRENT)).toBe(true);
  });
});

describe('readScopeCondition — warunek SQL zakresu odczytu', () => {
  const dialect = new PgDialect();
  const render = (scope: 'project' | 'all_projects') =>
    dialect.sqlToQuery(readScopeCondition(scope, 'proj_current'));

  it('project: wiąże projectId bieżącego projektu (jak sprzed v1.5)', () => {
    const { sql, params } = render('project');
    expect(sql).toContain('"project_id"');
    expect(params).toEqual(['global', 'project', 'proj_current']);
  });

  it('all_projects: bez filtra projectId — tylko scope global OR project', () => {
    const { sql, params } = render('all_projects');
    expect(sql).not.toContain('"project_id"');
    expect(params).toEqual(['global', 'project']);
  });
});
