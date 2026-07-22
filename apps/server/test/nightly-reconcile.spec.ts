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
  it('dopasowany + aktualny (nie stale) -> skip, brak create/withdraw/replacements', () => {
    const cond = condition();
    const existingProp = existing({ stale: false });

    const result = reconcile([cond], [existingProp]);

    expect(result.toCreate).toEqual([]);
    expect(result.toWithdraw).toEqual([]);
    expect(result.replacements.size).toBe(0);
    expect(result.skipped).toEqual(['prop_existing']);
  });

  it('dopasowany + stale -> "replace" sparowany: create nowego + wpis w replacements (NIE w toWithdraw)', () => {
    const cond = condition();
    const existingProp = existing({ stale: true });

    const result = reconcile([cond], [existingProp]);

    // Fix 2 (code review commit d057871): stary proposal NIE trafia bezpośrednio do `toWithdraw` —
    // to wołający (NightlyService) decyduje, czy sparowany `create` przetrwał flood cap, zanim
    // zastosuje odpowiadający mu withdraw.
    expect(result.toWithdraw).toEqual([]);
    expect(result.replacements.get(cond.conditionKey)).toBe('prop_existing');
    expect(result.replacements.size).toBe(1);
    expect(result.toCreate).toEqual([cond]);
    expect(result.skipped).toEqual([]);
  });

  it('brak dopasowania w existing -> create, żadnego withdraw/replacements', () => {
    const cond = condition();

    const result = reconcile([cond], []);

    expect(result.toCreate).toEqual([cond]);
    expect(result.toWithdraw).toEqual([]);
    expect(result.replacements.size).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it('existing bez dopasowania w detected (orphan) -> withdraw bezwarunkowo, bez create', () => {
    const existingProp = existing({ id: 'prop_orphan' });

    const result = reconcile([], [existingProp]);

    expect(result.toWithdraw).toEqual(['prop_orphan']);
    expect(result.replacements.size).toBe(0);
    expect(result.toCreate).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('mieszany przebieg: jeden skip, jeden stale-replace (sparowany), jeden nowy create, jeden orphan withdraw', () => {
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
    // Tylko orphan trafia do toWithdraw — stale-replace jest w `replacements`, nie tu.
    expect(result.toWithdraw).toEqual(['prop_orphan']);
    expect(result.replacements.get(staleCond.conditionKey)).toBe('prop_stale');
    expect(result.replacements.size).toBe(1);
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

    // Brak dopasowania -> istniejący merge staje się orphan (withdraw bezwarunkowo), delete jest
    // nowy (create). To NIE jest "replace" (różny conditionKey), więc `replacements` zostaje pusty.
    expect(result.toWithdraw).toEqual(['prop_existing']);
    expect(result.replacements.size).toBe(0);
    expect(result.toCreate).toEqual([deleteCond]);
    expect(result.skipped).toEqual([]);
  });

  it('capping symulowany przez wołającego: replacement, którego `cond` nie przetrwał capa, NIE jest stosowany (test kontraktu — realny cap żyje w NightlyService)', () => {
    // reconcile() samo nie zna capa (pure, bez DB) — ten test dokumentuje kontrakt, na którym
    // NightlyService buduje sparowany withdraw: `replacements` zwraca WSZYSTKIE pary niezależnie od
    // capa, a to wołający filtruje je po tym, co przetrwało obcięcie `toCreate`.
    const staleCond = condition({ affectedIds: ['mem_3', 'mem_4'] });
    const staleExisting = existing({ id: 'prop_stale', affectedIds: ['mem_3', 'mem_4'], stale: true });

    const result = reconcile([staleCond], [staleExisting]);
    expect(result.replacements.get(staleCond.conditionKey)).toBe('prop_stale');

    // Symulacja capa: `staleCond` zostaje ucięty (nie przetrwał do `finalToCreate`) -> wołający NIE
    // powinien wyciągnąć jego pary z `replacements` do zastosowania w tym przebiegu.
    const finalToCreate: typeof result.toCreate = [];
    const pairedWithdraw = finalToCreate
      .map((c) => result.replacements.get(c.conditionKey))
      .filter((id): id is string => id !== undefined);
    const allToWithdraw = [...result.toWithdraw, ...pairedWithdraw];

    expect(pairedWithdraw).toEqual([]);
    expect(allToWithdraw).toEqual([]); // stary "prop_stale" NIE jest wycofywany ten przebieg
  });
});
