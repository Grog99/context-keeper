import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Strażnik spójności czterech bloków tokenów w `globals.css` (design-system §7.1): każda zmiana
// palety musi trafić do wszystkich czterech, a pary akcentu muszą trzymać kontrast WCAG AA (§10).
const CSS_PATH = fileURLToPath(new URL('../src/globals.css', import.meta.url));

type Tokens = Map<string, string>;

const BLOCKS = {
  light: { label: ':root (jasny domyślny)', opener: /(?:^|\n):root\s*\{/ },
  mediaDark: {
    label: '@media (prefers-color-scheme: dark) :root',
    opener: /@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{\s*:root\s*\{/,
  },
  themeLight: { label: ":root[data-theme='light']", opener: /:root\[data-theme='light'\]\s*\{/ },
  themeDark: { label: ":root[data-theme='dark']", opener: /:root\[data-theme='dark'\]\s*\{/ },
} as const;

type BlockName = keyof typeof BLOCKS;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractBlockBody(css: string, name: BlockName): string {
  const { label, opener } = BLOCKS[name];
  const match = opener.exec(css);
  if (!match) throw new Error(`globals.css: nie znaleziono bloku ${label}`);
  const start = match.index + match[0].length;
  const end = css.indexOf('}', start);
  if (end === -1) throw new Error(`globals.css: niedomknięty blok ${label}`);
  return css.slice(start, end);
}

function parseHexTokens(body: string, name: BlockName): Tokens {
  const tokens: Tokens = new Map();
  for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens.set(`--${m[1]}`, m[2].toUpperCase());
  }
  if (tokens.size === 0) throw new Error(`globals.css: blok ${BLOCKS[name].label} nie ma żadnego tokenu hex`);
  return tokens;
}

function token(tokens: Tokens, name: BlockName, key: string): string {
  const value = tokens.get(key);
  if (value === undefined) throw new Error(`globals.css: brak tokenu ${key} w bloku ${BLOCKS[name].label}`);
  return value;
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6) throw new Error(`kontrast liczony tylko dla nieprzezroczystych #RGB/#RRGGBB, dostał ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

// WCAG 2.x relative luminance.
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const css = stripComments(readFileSync(CSS_PATH, 'utf8'));
const blocks = Object.fromEntries(
  (Object.keys(BLOCKS) as BlockName[]).map((name) => [name, parseHexTokens(extractBlockBody(css, name), name)]),
) as Record<BlockName, Tokens>;

describe('globals.css — spójność czterech bloków tokenów (design-system §7.1)', () => {
  it("parytet jasny: :root i :root[data-theme='light'] definiują te same tokeny hex z tymi samymi wartościami", () => {
    expect(Object.fromEntries(blocks.themeLight)).toEqual(Object.fromEntries(blocks.light));
  });

  it("parytet ciemny: @media dark :root i :root[data-theme='dark'] definiują te same tokeny hex z tymi samymi wartościami", () => {
    expect(Object.fromEntries(blocks.themeDark)).toEqual(Object.fromEntries(blocks.mediaDark));
  });

  it.each(Object.keys(BLOCKS) as BlockName[])(
    'niezmienniki akcentu w bloku %s: --ring = --primary, --info = --primary, --info-subtle = --accent-subtle',
    (name) => {
      const t = blocks[name];
      const primary = token(t, name, '--primary');
      expect(token(t, name, '--ring'), '--ring vs --primary').toBe(primary);
      expect(token(t, name, '--info'), '--info vs --primary').toBe(primary);
      expect(token(t, name, '--info-subtle'), '--info-subtle vs --accent-subtle').toBe(
        token(t, name, '--accent-subtle'),
      );
    },
  );
});

describe('globals.css — kontrast WCAG AA par akcentu (design-system §10)', () => {
  const PAIRS = [
    { fg: '--primary-foreground', bg: '--primary', min: 4.5 },
    { fg: '--primary-foreground', bg: '--primary-hover', min: 4.5 },
    { fg: '--info-foreground', bg: '--info-subtle', min: 4.5 },
    { fg: '--ring', bg: '--background', min: 3 },
    { fg: '--ring', bg: '--surface', min: 3 },
  ] as const;

  it.each(['light', 'mediaDark'] as const)('blok %s: każda para spełnia próg', (name) => {
    const t = blocks[name];
    for (const { fg, bg, min } of PAIRS) {
      const ratio = contrast(token(t, name, fg), token(t, name, bg));
      expect(ratio, `${fg} na ${bg} = ${ratio.toFixed(2)}:1, próg ${min}:1`).toBeGreaterThanOrEqual(min);
    }
  });
});
