import { describe, expect, it } from 'vitest';
import { generateId, ID_PREFIX, nano } from '../src/common/ids';

describe('ids', () => {
  it('nano: długość i alfabet base36', () => {
    expect(nano(12)).toMatch(/^[0-9a-z]{12}$/);
    expect(nano(6)).toMatch(/^[0-9a-z]{6}$/);
  });

  it('generateId: prefiks + losowa część', () => {
    expect(generateId(ID_PREFIX.memory)).toMatch(/^mem_[0-9a-z]{12}$/);
    expect(generateId(ID_PREFIX.project)).toMatch(/^proj_[0-9a-z]{12}$/);
  });

  it('generateId: brak kolizji w próbce', () => {
    const set = new Set(Array.from({ length: 2000 }, () => generateId('x')));
    expect(set.size).toBe(2000);
  });
});
