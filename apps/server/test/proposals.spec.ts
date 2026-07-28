import { describe, expect, it } from 'vitest';
import {
  BULK_MAX_IDS,
  computeStaleIds,
  normalizeBulkIds,
  ORIGIN_TO_SOURCE,
  pickEffectivePayload,
  toBulkItemError,
} from '../src/proposals/proposals.service';
import { ProposalError } from '../src/proposals/proposals.errors';

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

describe('normalizeBulkIds (roadmap v1.3, "Bulk approve/reject w kolejce" — walidacja/dedup koperty bulku, pure)', () => {
  it('kolejność pierwszego wystąpienia zachowana', () => {
    expect(normalizeBulkIds(['prop_c', 'prop_a', 'prop_b'])).toEqual(['prop_c', 'prop_a', 'prop_b']);
  });

  it('duplikaty kolapsują cicho, kolejność pierwszego wystąpienia', () => {
    expect(normalizeBulkIds(['prop_a', 'prop_b', 'prop_a', 'prop_c', 'prop_b'])).toEqual([
      'prop_a',
      'prop_b',
      'prop_c',
    ]);
  });

  it('trim whitespace na każdym elemencie', () => {
    expect(normalizeBulkIds([' prop_a ', '\tprop_b\n'])).toEqual(['prop_a', 'prop_b']);
  });

  it('nie-tablica -> validation_error', () => {
    expect(() => normalizeBulkIds('prop_a')).toThrow(ProposalError);
    expect(() => normalizeBulkIds('prop_a')).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(() => normalizeBulkIds(null)).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(() => normalizeBulkIds(undefined)).toThrow(expect.objectContaining({ code: 'validation_error' }));
  });

  it('tablica pusta -> validation_error (nic do zrobienia)', () => {
    expect(() => normalizeBulkIds([])).toThrow(expect.objectContaining({ code: 'validation_error' }));
  });

  it('element nie-string -> validation_error', () => {
    expect(() => normalizeBulkIds(['prop_a', 42])).toThrow(expect.objectContaining({ code: 'validation_error' }));
  });

  it('element pusty (po trim) -> validation_error', () => {
    expect(() => normalizeBulkIds(['prop_a', '   '])).toThrow(expect.objectContaining({ code: 'validation_error' }));
  });

  it('dokładnie BULK_MAX_IDS przechodzi, +1 nie', () => {
    const atCap = Array.from({ length: BULK_MAX_IDS }, (_, i) => `prop_${i}`);
    expect(normalizeBulkIds(atCap)).toHaveLength(BULK_MAX_IDS);

    const overCap = [...atCap, 'prop_over'];
    expect(() => normalizeBulkIds(overCap)).toThrow(expect.objectContaining({ code: 'validation_error' }));
  });
});

describe('toBulkItemError (roadmap v1.3 — ProposalError -> wiersz podsumowania bulku, pure)', () => {
  it('ProposalError(stale) -> staleIds przeniesione do wyniku', () => {
    const err = new ProposalError('stale', 'Nieaktualne', ['mem_a', 'mem_b']);
    expect(toBulkItemError('prop_1', err)).toEqual({
      id: 'prop_1',
      code: 'stale',
      message: 'Nieaktualne',
      staleIds: ['mem_a', 'mem_b'],
    });
  });

  it('ProposalError(already_decided) -> bez staleIds (pole w ogóle nieobecne w wyniku)', () => {
    const err = new ProposalError('already_decided', 'Już rozpatrzone', undefined, 'approved');
    const result = toBulkItemError('prop_2', err);
    expect(result).toEqual({ id: 'prop_2', code: 'already_decided', message: 'Już rozpatrzone' });
    expect(result.staleIds).toBeUndefined();
  });

  it('zwykły Error -> code:"unknown", oryginalna wiadomość NIE wycieka do klienta', () => {
    const err = new Error('szczegóły awarii bazy, nie dla klienta');
    const result = toBulkItemError('prop_3', err);
    expect(result.code).toBe('unknown');
    expect(result.id).toBe('prop_3');
    expect(result.message).not.toContain('szczegóły awarii bazy');
  });
});
