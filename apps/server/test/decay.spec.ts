import { describe, expect, it } from 'vitest';
import { eventDecayFactor } from '../src/memory/decay';

const HALFLIFE_DAYS = 30;
const NOW = new Date('2026-07-23T00:00:00Z');
const DAY_MS = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe('eventDecayFactor', () => {
  it('age=0 -> factor=1 (świeże teraz, brak kary)', () => {
    expect(eventDecayFactor(NOW, NOW, HALFLIFE_DAYS)).toBe(1);
  });

  it('age=halflife -> factor=0.5', () => {
    expect(eventDecayFactor(daysAgo(HALFLIFE_DAYS), NOW, HALFLIFE_DAYS)).toBeCloseTo(0.5, 10);
  });

  it('age=2*halflife -> factor=0.25', () => {
    expect(eventDecayFactor(daysAgo(2 * HALFLIFE_DAYS), NOW, HALFLIFE_DAYS)).toBeCloseTo(0.25, 10);
  });

  it('eventTime=null -> factor=1 (defensywnie, nie powinno się zdarzyć — wymuszone przy tworzeniu)', () => {
    expect(eventDecayFactor(null, NOW, HALFLIFE_DAYS)).toBe(1);
  });

  it('przyszła data (ujemny wiek) -> clamp do 1, NIGDY bonus rankingowy', () => {
    const future = new Date(NOW.getTime() + 10 * DAY_MS);
    expect(eventDecayFactor(future, NOW, HALFLIFE_DAYS)).toBe(1);
  });

  it('daleka przyszłość -> wciąż clamp do 1 (nie ujemny/nieskończony faktor)', () => {
    const farFuture = new Date(NOW.getTime() + 365 * DAY_MS);
    expect(eventDecayFactor(farFuture, NOW, HALFLIFE_DAYS)).toBe(1);
  });

  it('ściśle malejący wraz z wiekiem', () => {
    const ages = [0, 1, 5, 10, 20, 40, 80, 200];
    const factors = ages.map((d) => eventDecayFactor(daysAgo(d), NOW, HALFLIFE_DAYS));
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeLessThan(factors[i - 1]);
    }
  });

  it('half-life krótszy przyspiesza decay (ten sam wiek, mniejszy faktor)', () => {
    const age = daysAgo(15);
    const short = eventDecayFactor(age, NOW, 10);
    const long = eventDecayFactor(age, NOW, 60);
    expect(short).toBeLessThan(long);
  });
});
