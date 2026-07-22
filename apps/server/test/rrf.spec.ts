import { describe, expect, it } from 'vitest';
import { rrfFuse } from '../src/memory/rrf';

describe('rrfFuse', () => {
  it('lista jednoelementowa: kolejność zachowana (degeneracja do rankingu wejściowego)', () => {
    const fused = rrfFuse([['a', 'b', 'c']], 60);
    expect(fused.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    // score ściśle malejący — bez remisów przy pojedynczej liście
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
    expect(fused[1].score).toBeGreaterThan(fused[2].score);
  });

  it('znane listy -> znana kolejność fuzji (id na szczycie obu list wygrywa)', () => {
    const fts = ['x', 'y', 'z'];
    const vector = ['y', 'x', 'w'];
    const fused = rrfFuse([fts, vector], 60);
    // 'y': rank1(fts)=2 + rank1(vec)=1 -> 1/61 + 1/62; 'x': rank 1 + rank 2 -> 1/61 + 1/62 (symetrycznie)
    // sprawdzamy relacje, nie magiczne liczby: y i x remisują (obaj top-2 w obu listach), oboje przed z/w
    const ids = fused.map((r) => r.id);
    expect(ids.slice(0, 2).sort()).toEqual(['x', 'y']);
    expect(ids.slice(2)).toEqual(expect.arrayContaining(['z', 'w']));
  });

  it('score = suma 1/(k+rank) po listach, dokładna wartość dla prostego przypadku', () => {
    const fused = rrfFuse([['a']], 60);
    expect(fused).toEqual([{ id: 'a', score: 1 / 61 }]);
  });

  it('id obecne w obu listach dostaje wkład z KAŻDEJ (score wyższy niż bycie tylko na jednej)', () => {
    const onlyFts = rrfFuse([['a', 'b'], []], 60);
    const both = rrfFuse([['a', 'b'], ['a']], 60);
    const scoreAOnlyFts = onlyFts.find((r) => r.id === 'a')!.score;
    const scoreABoth = both.find((r) => r.id === 'a')!.score;
    expect(scoreABoth).toBeGreaterThan(scoreAOnlyFts);
  });

  it('id obecny tylko w jednej liście nie dostaje wkładu z drugiej (brak = brak, nie rank nieskończony=0)', () => {
    const fused = rrfFuse([['a'], ['b']], 60);
    expect(fused.find((r) => r.id === 'a')!.score).toBe(1 / 61);
    expect(fused.find((r) => r.id === 'b')!.score).toBe(1 / 61);
  });

  it('większe k spłaszcza różnice między rankami (score bliżej siebie)', () => {
    const smallK = rrfFuse([['a', 'b', 'c']], 1);
    const bigK = rrfFuse([['a', 'b', 'c']], 1000);
    const spreadSmallK = smallK[0].score - smallK[2].score;
    const spreadBigK = bigK[0].score - bigK[2].score;
    expect(spreadBigK).toBeLessThan(spreadSmallK);
  });

  it('puste listy -> pusty wynik', () => {
    expect(rrfFuse([[], []], 60)).toEqual([]);
    expect(rrfFuse([], 60)).toEqual([]);
  });

  it('nie mutuje list wejściowych', () => {
    const fts = ['a', 'b'];
    const vector = ['b', 'a'];
    rrfFuse([fts, vector], 60);
    expect(fts).toEqual(['a', 'b']);
    expect(vector).toEqual(['b', 'a']);
  });
});
