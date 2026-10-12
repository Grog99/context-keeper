import { describe, expect, it } from 'vitest';
import type { InlineDiffSegment } from '../src/lib/text-diff';
import { computeInlineWordDiff, MAX_CHANGED_RATIO, WORD_DIFF_MAX_CHARS } from '../src/lib/text-diff';

function joinTexts(segments: InlineDiffSegment[], skip: InlineDiffSegment['type']): string {
  return segments
    .filter((s) => s.type !== skip)
    .map((s) => s.text)
    .join('');
}

describe('computeInlineWordDiff — inline diff w DiffView (tech-review #11, §8.2 design-systemu)', () => {
  it('zwykła zmiana słowa → ok: true z segmentami same/del/add', () => {
    expect(computeInlineWordDiff('Ala ma kota i psa', 'Ala ma kota i chomika')).toEqual({
      ok: true,
      segments: [
        { type: 'same', text: 'Ala ma kota i ' },
        { type: 'del', text: 'psa' },
        { type: 'add', text: 'chomika' },
      ],
    });
  });

  it('powyżej WORD_DIFF_MAX_CHARS → too-long bez segments; dokładnie na limicie diff jest liczony', () => {
    const half = WORD_DIFF_MAX_CHARS / 2;

    const over = computeInlineWordDiff('a'.repeat(half), 'a'.repeat(half + 1));
    expect(over).toStrictEqual({ ok: false, reason: 'too-long' });
    expect(over).not.toHaveProperty('segments');

    // Suma długości === WORD_DIFF_MAX_CHARS — próg jest „powyżej", nie „od".
    const atLimit = computeInlineWordDiff('a'.repeat(half), 'a'.repeat(half - 1) + 'b');
    expect(atLimit).not.toMatchObject({ reason: 'too-long' });
  });

  it(`powyżej MAX_CHANGED_RATIO (${MAX_CHANGED_RATIO}) → too-different Z segments`, () => {
    expect(computeInlineWordDiff('jeden dwa trzy', 'cztery pięć sześć')).toEqual({
      ok: false,
      reason: 'too-different',
      segments: [
        { type: 'del', text: 'jeden dwa trzy' },
        { type: 'add', text: 'cztery pięć sześć' },
      ],
    });
  });

  it.each([
    ['podwójna spacja', 'Ala ma kota', 'Ala ma  kota'],
    ['spacja → nowa linia', 'Ala ma kota', 'Ala\nma kota'],
  ])('zmiana wyłącznie białych znaków (%s) → whitespace-only Z segments', (_label, before, after) => {
    expect(computeInlineWordDiff(before, after)).toEqual({
      ok: false,
      reason: 'whitespace-only',
      segments: [{ type: 'same', text: after }],
    });
  });

  describe('D5 — białe znaki na brzegu zmienionego tokenu wychodzą poza add/del', () => {
    it('dodane słowa: add bez brzegowych spacji, sklejenie bez del daje after', () => {
      const before = 'Ala ma kota';
      const after = 'Ala ma bardzo dużego kota';
      const result = computeInlineWordDiff(before, after);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.segments).toContainEqual({ type: 'add', text: 'bardzo dużego' });
      for (const s of result.segments.filter((x) => x.type !== 'same')) {
        expect(s.text).toBe(s.text.trim());
      }
      expect(joinTexts(result.segments, 'del')).toBe(after);
    });

    it('usunięte słowo: del bez brzegowych spacji, sklejenie bez add daje before', () => {
      const before = 'a b c';
      const after = 'a c';
      const result = computeInlineWordDiff(before, after);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.segments).toContainEqual({ type: 'del', text: 'b' });
      for (const s of result.segments.filter((x) => x.type !== 'same')) {
        expect(s.text).toBe(s.text.trim());
      }
      expect(joinTexts(result.segments, 'add')).toBe(before);
    });
  });
});
