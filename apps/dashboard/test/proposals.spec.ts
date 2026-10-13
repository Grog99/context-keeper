import { describe, expect, it } from 'vitest';
import { approveBlockReason, conflictTargetAge, percentShares, swapDirectionLabel } from '../src/lib/proposals';

describe('percentShares — całkowite procenty sumujące się do 100 (tech-review #11)', () => {
  it('suma 100 tam, gdzie Math.round daje 99', () => {
    // Math.round(33.33…) ×3 → 99.
    expect(percentShares([1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('suma 100 tam, gdzie Math.round daje 101', () => {
    // Math.round(16.67) + Math.round(16.67) + Math.round(66.67) → 17 + 17 + 67 = 101.
    expect(percentShares([1, 1, 4])).toEqual([17, 17, 66]);
  });

  it('pusta kohorta → same zera', () => {
    expect(percentShares([0, 0, 0])).toEqual([0, 0, 0]);
    expect(percentShares([])).toEqual([]);
  });
});

describe('conflictTargetAge — wiek targetu w proposalu sprzeczności (roadmap v1.6, B3)', () => {
  it('wcześniejszy createdAt → older, późniejszy → newer (niezależnie od id)', () => {
    // id celowo odwrotnie do dat — data ma pierwszeństwo przed id.
    const earlier = { id: 'mem_b', createdAt: '2026-03-01T10:00:00.000Z' };
    const later = { id: 'mem_a', createdAt: '2026-03-02T10:00:00.000Z' };

    expect(conflictTargetAge(earlier, later)).toBe('older');
    expect(conflictTargetAge(later, earlier)).toBe('newer');
  });

  it('równy createdAt → mniejsze id jest starsze', () => {
    const createdAt = '2026-03-01T10:00:00.000Z';
    const a = { id: 'mem_a', createdAt };
    const b = { id: 'mem_b', createdAt };

    expect(conflictTargetAge(a, b)).toBe('older');
    expect(conflictTargetAge(b, a)).toBe('newer');
  });

  const valid = '2026-03-01T10:00:00.000Z';
  it.each([
    ['brak daty targetu', undefined, valid],
    ['brak daty kontrpartnera', valid, undefined],
    ['niepoprawna data targetu', 'nie-data', valid],
    ['niepoprawna data kontrpartnera', valid, 'nie-data'],
  ])('%s → null', (_label, targetCreatedAt, counterpartCreatedAt) => {
    expect(
      conflictTargetAge(
        { id: 'mem_a', createdAt: targetCreatedAt },
        { id: 'mem_b', createdAt: counterpartCreatedAt },
      ),
    ).toBeNull();
  });
});

describe('swapDirectionLabel — etykieta nazywa wpis archiwizowany po kliknięciu (roadmap v1.6, B3)', () => {
  it('target starszy → etykieta mówi o nowszym, nie o starszym', () => {
    const label = swapDirectionLabel('older');
    expect(label).toMatch(/nowszy/);
    expect(label).not.toMatch(/starszy/);
  });

  it('target nowszy → etykieta mówi o starszym, nie o nowszym', () => {
    const label = swapDirectionLabel('newer');
    expect(label).toMatch(/starszy/);
    expect(label).not.toMatch(/nowszy/);
  });

  it('kierunek nieznany (null) → etykieta nie mówi ani o starszym, ani o nowszym', () => {
    const label = swapDirectionLabel(null);
    expect(label).not.toMatch(/starszy/);
    expect(label).not.toMatch(/nowszy/);
  });
});

describe('approveBlockReason — zatwierdzenie nieaktualnej propozycji blokowane przed requestem (roadmap v1.8, Bugi z przeglądu UX)', () => {
  it('propozycja stale → powód blokady stale', () => {
    expect(approveBlockReason({ stale: true })).toBe('stale');
  });

  it('propozycja aktualna → brak blokady (null)', () => {
    expect(approveBlockReason({ stale: false })).toBeNull();
  });
});
