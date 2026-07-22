import { describe, expect, it } from 'vitest';
import { toErrorEnvelope, ToolError } from '../src/common/errors';
import { classifyDedup } from '../src/memory/dedup';

describe('ToolError / toErrorEnvelope (taksonomia błędów, §5 tech-stack)', () => {
  it('mapuje na kopertę {code, message} — code stabilne', () => {
    const err = new ToolError('not_found', 'Pamięć nie istnieje: mem_xyz');
    expect(toErrorEnvelope(err)).toEqual({ code: 'not_found', message: 'Pamięć nie istnieje: mem_xyz' });
  });

  it('trzy stabilne kody z taksonomii', () => {
    expect(new ToolError('validation_error', 'x').code).toBe('validation_error');
    expect(new ToolError('secret_blocked', 'x').code).toBe('secret_blocked');
    expect(new ToolError('not_found', 'x').code).toBe('not_found');
  });
});

describe('classifyDedup (FR-M8 — advisory dedup, czysta klasyfikacja)', () => {
  it('brak dopasowań -> pending (nowy create)', () => {
    expect(classifyDedup(null, null)).toEqual({ status: 'pending' });
  });

  it('exact match do pending proposala -> duplicate_pending (id proposala)', () => {
    expect(classifyDedup({ id: 'prop_abc' }, null)).toEqual({
      status: 'duplicate_pending',
      existingId: 'prop_abc',
    });
  });

  it('exact match do approved memory -> already_exists (id pamięci)', () => {
    expect(classifyDedup(null, { id: 'mem_abc' })).toEqual({
      status: 'already_exists',
      existingId: 'mem_abc',
    });
  });

  it('pending wygrywa przed approved, gdyby oba istniały', () => {
    expect(classifyDedup({ id: 'prop_abc' }, { id: 'mem_xyz' })).toEqual({
      status: 'duplicate_pending',
      existingId: 'prop_abc',
    });
  });
});
