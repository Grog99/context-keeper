import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/common/errors';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import { HEADER_MAX_LEN, normalizeHeader, normalizeTags, validateBody } from '../src/memory/validation';

function testConfig(overrides: Partial<Record<string, unknown>> = {}): AppConfigService {
  const env = envSchema.parse({ DATABASE_URL: 'postgres://unused', ...overrides });
  return new AppConfigService(env);
}

describe('normalizeHeader', () => {
  it('przycina i zwija białe znaki (w tym newline)', () => {
    expect(normalizeHeader('  Tytuł   z   \n  nowa linia  ')).toBe('Tytuł z nowa linia');
  });

  it('odrzuca pusty header', () => {
    expect(() => normalizeHeader('   ')).toThrow(ToolError);
  });

  it(`odrzuca header dłuższy niż ${HEADER_MAX_LEN} znaków`, () => {
    const tooLong = 'a'.repeat(HEADER_MAX_LEN + 1);
    expect(() => normalizeHeader(tooLong)).toThrow(ToolError);
  });

  it(`akceptuje header dokładnie ${HEADER_MAX_LEN} znaków`, () => {
    const exact = 'a'.repeat(HEADER_MAX_LEN);
    expect(normalizeHeader(exact)).toBe(exact);
  });
});

describe('validateBody', () => {
  it('odrzuca puste body', () => {
    expect(() => validateBody('', 'fact', testConfig())).toThrow(ToolError);
  });

  it('respektuje limit BODY_MAX_FACT z configu', () => {
    const config = testConfig({ BODY_MAX_FACT: 10 });
    expect(() => validateBody('a'.repeat(11), 'fact', config)).toThrow(ToolError);
    expect(validateBody('a'.repeat(10), 'fact', config)).toBe('a'.repeat(10));
  });

  it('document ma osobny (większy) limit niż fact', () => {
    const config = testConfig({ BODY_MAX_FACT: 5, BODY_MAX_DOCUMENT: 100 });
    expect(() => validateBody('a'.repeat(50), 'fact', config)).toThrow(ToolError);
    expect(validateBody('a'.repeat(50), 'document', config)).toBe('a'.repeat(50));
  });

  it('liczy limit w bajtach UTF-8, nie w znakach (wielobajtowe znaki)', () => {
    const config = testConfig({ BODY_MAX_FACT: 4 });
    // 'ą' to 2 bajty w UTF-8 — 2 znaki 'ą' to już 4 bajty (limit), 3. znak przekracza.
    expect(validateBody('ąą', 'fact', config)).toBe('ąą');
    expect(() => validateBody('ąąą', 'fact', config)).toThrow(ToolError);
  });
});

describe('normalizeTags', () => {
  it('trim + lowercase + collapse whitespace', () => {
    expect(normalizeTags(['  Postgres  ', 'PG-Vector'], testConfig())).toEqual([
      'postgres',
      'pg-vector',
    ]);
  });

  it('odrzuca zbyt wiele tagów (TAGS_MAX)', () => {
    const config = testConfig({ TAGS_MAX: 2 });
    expect(() => normalizeTags(['a', 'b', 'c'], config)).toThrow(ToolError);
  });

  it('odrzuca zbyt długi tag (TAG_MAX_LEN)', () => {
    const config = testConfig({ TAG_MAX_LEN: 3 });
    expect(() => normalizeTags(['abcd'], config)).toThrow(ToolError);
    expect(normalizeTags(['abc'], config)).toEqual(['abc']);
  });

  it('odrzuca tag spoza charsetu [a-z0-9-_/]', () => {
    expect(() => normalizeTags(['foo bar'], testConfig())).toThrow(ToolError);
    expect(() => normalizeTags(['foo!'], testConfig())).toThrow(ToolError);
    expect(normalizeTags(['foo-bar_baz/qux'], testConfig())).toEqual(['foo-bar_baz/qux']);
  });

  it('deduplikuje po normalizacji', () => {
    expect(normalizeTags(['Foo', 'foo', ' FOO '], testConfig())).toEqual(['foo']);
  });

  it('brak tagów -> pusta lista', () => {
    expect(normalizeTags(undefined, testConfig())).toEqual([]);
    expect(normalizeTags([], testConfig())).toEqual([]);
  });
});
