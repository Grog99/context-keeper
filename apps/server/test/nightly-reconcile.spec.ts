import { describe, expect, it } from 'vitest';
import { conditionKey, type DetectedCondition } from '../src/nightly/nightly.types';
import { reconcile, type ExistingNightlyProposal } from '../src/nightly/reconcile';

function condition(overrides: Partial<DetectedCondition> = {}): DetectedCondition {
  const affectedIds = overrides.affectedIds ?? ['mem_a', 'mem_b'];
  const type = overrides.type ?? 'merge';
  return {
    type,
    scope: 'project',
    projectId: 'proj_x',
    affectedIds,
    baseVersions: { mem_a: 0, mem_b: 0 },
    payload: { memoryId: 'mem_c', header: 'H', body: 'B', tags: [], kind: 'fact' },
    conditionKey: conditionKey(type, affectedIds),
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingNightlyProposal> = {}): ExistingNightlyProposal {
  return {
    id: 'prop_existing',
    type: 'merge',
    affectedIds: ['mem_a', 'mem_b'],
    stale: false,
    ...overrides,
  };
}

describe('reconcile (Faza 6 — tabela decyzji self-cleaning re-scan)', () => {
  it('dopasowany + aktualny (nie stale) -> skip, brak create/withdraw', () => {
    const cond = condition();
    const existingProp = existing({ stale: false });

    const result = reconcile([cond], [existingProp]);

    expect(result.toCreate).toEqual([]);
    expect(result.toWithdraw).toEqual([]);
    expect(result.skipped).toEqual(['prop_existing']);
  });

  it('dopasowany + stale -> withdraw starego ORAZ create nowego', () => {
    const cond = condition();
    const existingProp = existing({ stale: true });

    const result = reconcile([cond], [existingProp]);

    expect(result.toWithdraw).toEqual(['prop_existing']);
    expect(result.toCreate).toEqual([cond]);
    expect(result.skipped).toEqual([]);
  });

  it('brak dopasowania w existing -> create, żadnego withdraw', () => {
    const cond = condition();

    const result = reconcile([cond], []);

    expect(result.toCreate).toEqual([cond]);
    expect(result.toWithdraw).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('existing bez dopasowania w detected (orphan) -> withdraw, bez create', () => {
    const existingProp = existing({ id: 'prop_orphan' });

    const result = reconcile([], [existingProp]);

    expect(result.toWithdraw).toEqual(['prop_orphan']);
    expect(result.toCreate).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('mieszany przebieg: jeden skip, jeden stale-replace, jeden nowy create, jeden orphan withdraw', () => {
    const skipCond = condition({ affectedIds: ['mem_1', 'mem_2'] });
    const staleCond = condition({ affectedIds: ['mem_3', 'mem_4'] });
    const newCond = condition({ affectedIds: ['mem_5', 'mem_6'] });

    const skipExisting = existing({ id: 'prop_skip', affectedIds: ['mem_1', 'mem_2'], stale: false });
    const staleExisting = existing({ id: 'prop_stale', affectedIds: ['mem_3', 'mem_4'], stale: true });
    const orphanExisting = existing({ id: 'prop_orphan', affectedIds: ['mem_9', 'mem_10'], stale: false });

    const result = reconcile(
      [skipCond, staleCond, newCond],
      [skipExisting, staleExisting, orphanExisting],
    );

    expect(result.skipped).toEqual(['prop_skip']);
    expect([...result.toWithdraw].sort()).toEqual(['prop_orphan', 'prop_stale']);
    expect(result.toCreate).toEqual([staleCond, newCond]);
  });

  it('dopasowanie po conditionKey ignoruje kolejność affectedIds (posortowane przy konstrukcji klucza)', () => {
    // affectedIds w DetectedCondition już posortowane przez producenta; test dokumentuje, że
    // reconcile samo NIE sortuje na nowo — polega na tym, że conditionKey jest już kanoniczny.
    const cond = condition({ affectedIds: ['mem_a', 'mem_b'] });
    const existingProp = existing({ affectedIds: ['mem_a', 'mem_b'], stale: false });

    const result = reconcile([cond], [existingProp]);
    expect(result.skipped).toEqual(['prop_existing']);
  });

  it('różny type z tymi samymi affectedIds NIE dopasowuje (conditionKey rozróżnia merge/delete)', () => {
    const deleteCond = condition({ type: 'delete', affectedIds: ['mem_a'] });
    const mergeExisting = existing({ type: 'merge', affectedIds: ['mem_a'] });

    const result = reconcile([deleteCond], [mergeExisting]);

    // Brak dopasowania -> istniejący merge staje się orphan (withdraw), delete jest nowy (create).
    expect(result.toWithdraw).toEqual(['prop_existing']);
    expect(result.toCreate).toEqual([deleteCond]);
    expect(result.skipped).toEqual([]);
  });
});
