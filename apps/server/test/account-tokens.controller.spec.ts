import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuditService } from '../src/audit/audit.service';
import { AccountTokensController } from '../src/dashboard/account-tokens.controller';
import { DASHBOARD_ACTOR } from '../src/dashboard/dashboard.constants';
import type { ProjectsService, PublicTokenRow } from '../src/projects/projects.service';
import type { UsageService } from '../src/usage/usage.service';

const NO_QUERY = {} as Record<string, never>;
const NO_BODY = {} as Record<string, never>;

function tokenRow(overrides: Partial<PublicTokenRow> = {}): PublicTokenRow {
  return {
    id: 'tok_acc1',
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

interface Logged {
  eventType: string;
  actor: string;
  metadata: Record<string, unknown>;
}

/** Fake serwisy — `AccountTokensController` to cienki wrapper nad `ProjectsService` (audyt w kontrolerze).
 * `listAccountTokens` zwraca TYLKO tokeny konta, więc id tokenu projektowego nigdy tam nie trafi (404). */
function setup(accountTokens: PublicTokenRow[] = [tokenRow()]) {
  const logged: Logged[] = [];
  const mutations: string[] = [];
  const rotated = tokenRow({ id: 'tok_acc2', label: 'laptop' });
  const previous = tokenRow({
    status: 'grace',
    expiresAt: new Date('2026-02-01T00:00:00Z'),
    graceStartedAt: new Date('2026-01-31T00:00:00Z'),
  });
  const projects = {
    listAccountTokens: async () => accountTokens,
    createAccountToken: async (label: string) => {
      mutations.push('createAccountToken');
      return { token: 'ck_plaintext', tokenRow: tokenRow({ id: 'tok_new', label }) };
    },
    rotateToken: async () => {
      mutations.push('rotateToken');
      return { token: 'ck_rotated', tokenRow: rotated, previousTokenRow: previous };
    },
    revokeToken: async (id: string) => {
      mutations.push('revokeToken');
      return tokenRow({ id, status: 'revoked', revokedAt: new Date() });
    },
    updateTokenLabel: async (id: string, label: string) => {
      mutations.push('updateTokenLabel');
      return tokenRow({ id, label });
    },
  } as unknown as ProjectsService;
  const usage = {
    countSearchesByAccountTokens: async () => new Map([['tok_acc1', 7]]),
  } as unknown as UsageService;
  const audit = { log: async (e: Logged) => void logged.push(e) } as unknown as AuditService;
  return { controller: new AccountTokensController(projects, usage, audit), logged, mutations };
}

describe('AccountTokensController (roadmap v1.5, scope C)', () => {
  it('GET: DTO z effectiveStatus + searches30d, projectId null, BEZ tokenHash', async () => {
    const { controller } = setup([tokenRow(), tokenRow({ id: 'tok_acc9', label: 'ci' })]);
    const list = await controller.list(NO_QUERY);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'tok_acc1', projectId: null, effectiveStatus: 'active', searches30d: 7 });
    expect(list[1].searches30d).toBe(0);
    for (const dto of list) expect(dto).not.toHaveProperty('tokenHash');
  });

  it('POST: audyt token_created ma scope:account i NIE ma projectId', async () => {
    const { controller, logged } = setup();
    const created = await controller.create({ label: 'ci' }, NO_QUERY);
    expect(created.token).toBe('ck_plaintext');
    expect(logged).toEqual([
      {
        eventType: 'token_created',
        actor: DASHBOARD_ACTOR,
        metadata: { scope: 'account', tokenId: 'tok_new', label: 'ci' },
      },
    ]);
    expect(logged[0].metadata).not.toHaveProperty('projectId');
  });

  it('rotate: audyt token_rotated niesie stare/nowe id+etykietę i graceExpiresAt, bez projectId', async () => {
    const { controller, logged } = setup();
    await controller.rotate('tok_acc1', NO_QUERY, NO_BODY);
    expect(logged).toEqual([
      {
        eventType: 'token_rotated',
        actor: DASHBOARD_ACTOR,
        metadata: {
          scope: 'account',
          oldTokenId: 'tok_acc1',
          oldLabel: 'laptop',
          newTokenId: 'tok_acc2',
          newLabel: 'laptop',
          graceExpiresAt: new Date('2026-02-01T00:00:00Z'),
        },
      },
    ]);
  });

  it('revoke: audyt token_revoked z scope:account', async () => {
    const { controller, logged } = setup();
    const revoked = await controller.revoke('tok_acc1', NO_QUERY, NO_BODY);
    expect(revoked.status).toBe('revoked');
    expect(logged).toEqual([
      {
        eventType: 'token_revoked',
        actor: DASHBOARD_ACTOR,
        metadata: { scope: 'account', tokenId: 'tok_acc1', label: 'laptop' },
      },
    ]);
  });

  it('PATCH: audyt token_relabeled ze starą i nową etykietą', async () => {
    const { controller, logged } = setup();
    await controller.updateLabel('tok_acc1', { label: 'desktop' }, NO_QUERY);
    expect(logged).toEqual([
      {
        eventType: 'token_relabeled',
        actor: DASHBOARD_ACTOR,
        metadata: { scope: 'account', tokenId: 'tok_acc1', oldLabel: 'laptop', newLabel: 'desktop' },
      },
    ]);
  });

  it('id tokenu projektowego (nie ma go wśród tokenów konta) -> 404, mutacja NIGDY nie wywołana, bez audytu', async () => {
    const { controller, logged, mutations } = setup();
    await expect(controller.rotate('tok_project1', NO_QUERY, NO_BODY)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.revoke('tok_project1', NO_QUERY, NO_BODY)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.updateLabel('tok_project1', { label: 'x' }, NO_QUERY)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mutations).toEqual([]);
    expect(logged).toEqual([]);
  });
});
