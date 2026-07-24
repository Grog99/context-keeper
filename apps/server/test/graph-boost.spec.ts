import { describe, expect, it } from 'vitest';
import { graphBoostFactor, selectBoostedIds } from '../src/memory/graph-boost';

describe('selectBoostedIds', () => {
  it('oba końce w zbiorze kandydatów -> oba boostowane', () => {
    const boosted = selectBoostedIds(
      ['mem_a', 'mem_b'],
      [{ fromMemoryId: 'mem_a', toMemoryId: 'mem_b' }],
    );
    expect(boosted).toEqual(new Set(['mem_a', 'mem_b']));
  });

  it('jeden koniec POZA zbiorem kandydatów -> re-rank only, brak boosta (żaden z id-ów)', () => {
    const boosted = selectBoostedIds(
      ['mem_a'],
      [{ fromMemoryId: 'mem_a', toMemoryId: 'mem_outside' }],
    );
    expect(boosted.size).toBe(0);
  });

  it('self-loop ignorowany defensywnie, mimo że schema go blokuje na poziomie insertu', () => {
    const boosted = selectBoostedIds(['mem_a'], [{ fromMemoryId: 'mem_a', toMemoryId: 'mem_a' }]);
    expect(boosted.size).toBe(0);
  });

  it('puste krawędzie -> pusty zbiór', () => {
    expect(selectBoostedIds(['mem_a', 'mem_b'], []).size).toBe(0);
  });

  it('wiele krawędzi -> boost przechodni po całym połączonym zbiorze kandydatów', () => {
    const boosted = selectBoostedIds(
      ['mem_a', 'mem_b', 'mem_c', 'mem_d'],
      [
        { fromMemoryId: 'mem_a', toMemoryId: 'mem_b' },
        { fromMemoryId: 'mem_c', toMemoryId: 'mem_outside' }, // odrzucone — mem_outside spoza zbioru
      ],
    );
    expect(boosted).toEqual(new Set(['mem_a', 'mem_b']));
  });

  it('kierunek krawędzi nie ma znaczenia — symetryczny odczyt (to->from tak samo boostuje jak from->to)', () => {
    const boosted = selectBoostedIds(
      ['mem_a', 'mem_b'],
      [{ fromMemoryId: 'mem_b', toMemoryId: 'mem_a' }],
    );
    expect(boosted).toEqual(new Set(['mem_a', 'mem_b']));
  });
});

describe('graphBoostFactor', () => {
  it('isBoosted=false -> 1 (no-op), niezależnie od wagi', () => {
    expect(graphBoostFactor(false, 0.1)).toBe(1);
    expect(graphBoostFactor(false, 5)).toBe(1);
  });

  it('isBoosted=true, weight=0.1 -> 1.1', () => {
    expect(graphBoostFactor(true, 0.1)).toBeCloseTo(1.1, 10);
  });

  it('weight=0 -> 1, nawet gdy isBoosted=true (knob wyłącza boost)', () => {
    expect(graphBoostFactor(true, 0)).toBe(1);
  });

  it('weight ujemny (nie powinien się zdarzyć — env nonnegative — ale defensywnie) -> 1', () => {
    expect(graphBoostFactor(true, -0.5)).toBe(1);
  });

  it('faktor bounded przez 1+weight, nie kumuluje się (binarny, nie degree-scaled)', () => {
    expect(graphBoostFactor(true, 0.1)).toBe(1.1);
    expect(graphBoostFactor(true, 1)).toBe(2);
  });
});
