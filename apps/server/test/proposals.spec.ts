import { describe, expect, it } from 'vitest';
import {
  computeStaleIds,
  ORIGIN_TO_SOURCE,
  pickEffectivePayload,
} from '../src/proposals/proposals.service';

describe('computeStaleIds (§1.2 planu Fazy 4 — klasyfikator staleness, pure)', () => {
  it('wszystkie wersje zgodne -> pusta lista (nic nie jest stale)', () => {
    const current = new Map([
      ['mem_a', 0],
      ['mem_b', 3],
    ]);
    const base = { mem_a: 0, mem_b: 3 };
    expect(computeStaleIds(current, base, ['mem_a', 'mem_b'])).toEqual([]);
  });

  it('jeden rozjazd wersji -> tylko ten id w staleIds', () => {
    const current = new Map([
      ['mem_a', 1], // zmieniony od czasu proposala (base=0)
      ['mem_b', 3],
    ]);
    const base = { mem_a: 0, mem_b: 3 };
    expect(computeStaleIds(current, base, ['mem_a', 'mem_b'])).toEqual(['mem_a']);
  });

  it('brakujący wiersz (purged/gone) liczy się jako stale', () => {
    const current = new Map([['mem_b', 3]]); // mem_a w ogóle nie istnieje
    const base = { mem_a: 0, mem_b: 3 };
    expect(computeStaleIds(current, base, ['mem_a', 'mem_b'])).toEqual(['mem_a']);
  });

  it('affectedIds puste -> zawsze pusty wynik (create bez affected_ids)', () => {
    expect(computeStaleIds(new Map(), {}, [])).toEqual([]);
  });

  it('kolejność staleIds odpowiada kolejności affectedIds (deterministyczna)', () => {
    const current = new Map([
      ['mem_a', 5],
      ['mem_b', 5],
      ['mem_c', 5],
    ]);
    const base = { mem_a: 0, mem_b: 0, mem_c: 0 };
    expect(computeStaleIds(current, base, ['mem_c', 'mem_a', 'mem_b'])).toEqual(['mem_c', 'mem_a', 'mem_b']);
  });
});

describe('pickEffectivePayload (§1.4 planu — edit-before-approve)', () => {
  it('editedPayload obecny -> wygrywa nad payload', () => {
    const row = { payload: { header: 'oryginal' }, editedPayload: { header: 'edycja recenzenta' } };
    expect(pickEffectivePayload(row)).toEqual({ header: 'edycja recenzenta' });
  });

  it('editedPayload=null -> spada na payload (oryginał agenta)', () => {
    const row = { payload: { header: 'oryginal' }, editedPayload: null };
    expect(pickEffectivePayload(row)).toEqual({ header: 'oryginal' });
  });
});

describe('ORIGIN_TO_SOURCE (§1.3 planu — mapowanie origin proposala -> source materializowanej pamięci)', () => {
  it('mapowanie 1:1 dla wszystkich trzech wartości (agent/human/nightly)', () => {
    expect(ORIGIN_TO_SOURCE.agent).toBe('agent');
    expect(ORIGIN_TO_SOURCE.human).toBe('human');
    expect(ORIGIN_TO_SOURCE.nightly).toBe('nightly');
  });
});
