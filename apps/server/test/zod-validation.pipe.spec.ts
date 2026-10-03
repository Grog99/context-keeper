import type { ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolError } from '../src/common/errors';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';

function queryMeta(): ArgumentMetadata {
  return { type: 'query', metatype: Object, data: undefined };
}

function bodyMeta(): ArgumentMetadata {
  return { type: 'body', metatype: Object, data: undefined };
}

function paramMeta(name: string): ArgumentMetadata {
  return { type: 'param', metatype: String, data: name };
}

describe('ZodValidationPipe (tech-review #3, roadmap v1.4 — "JSON API dashboardu bez walidacji runtime")', () => {
  it('dane poprawne -> zwraca sparsowaną/stransformowaną wartość (z.output, nie surowy input)', () => {
    const schema = z.strictObject({ n: z.string().regex(/^\d+$/).transform(Number) });
    const pipe = new ZodValidationPipe(schema);

    const result = pipe.transform({ n: '42' }, queryMeta());

    expect(result).toEqual({ n: 42 });
  });

  it('dane niepoprawne -> rzuca ToolError(validation_error)', () => {
    const schema = z.strictObject({ kind: z.enum(['fact', 'document']) });
    const pipe = new ZodValidationPipe(schema);

    expect(() => pipe.transform({ kind: 'bogus' }, queryMeta())).toThrow(ToolError);
    try {
      pipe.transform({ kind: 'bogus' }, queryMeta());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('validation_error');
    }
  });

  it('komunikat błędu query niesie prefiks "query.<pole>"', () => {
    const schema = z.strictObject({ kind: z.enum(['fact', 'document']) });
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ kind: 'bogus' }, queryMeta());
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).message).toContain('query.kind');
      expect((err as ToolError).message.startsWith('Invalid input — ')).toBe(true);
    }
  });

  it('komunikat błędu param niesie prefiks "param <nazwa>" (bez ścieżki dla prymitywnej wartości)', () => {
    const schema = z.string().regex(/^[a-z]+$/);
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform('BOGUS-123', paramMeta('id'));
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).message).toContain('param id:');
    }
  });

  it('komunikat błędu body niesie ścieżkę zagnieżdżoną z indeksem tablicy ("body.tags[1]")', () => {
    const schema = z.strictObject({ tags: z.array(z.string().max(3)) });
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ tags: ['ok', 'zbyt-dlugi-tag'] }, bodyMeta());
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).message).toContain('body.tags[1]');
    }
  });

  it('nierozpoznany klucz -> komunikat wymienia nazwę klucza (z.strictObject, unrecognized_keys)', () => {
    const schema = z.strictObject({ a: z.string() });
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ a: 'x', extra: 'y' }, queryMeta());
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).message).toContain('extra');
    }
  });

  it('query: "" jest odrzucane PRZED parsowaniem (pusty string w query = brak wartości, nie invalid enum)', () => {
    const schema = z.strictObject({ kind: z.enum(['fact', 'document']).optional() });
    const pipe = new ZodValidationPipe(schema);

    const result = pipe.transform({ kind: '' }, queryMeta());

    expect(result).toEqual({});
  });

  it('query: tablica z pustymi elementami -> puste elementy odfiltrowane, klucz znika gdy tablica staje się pusta', () => {
    const schema = z.strictObject({ tags: z.array(z.string()).optional() });
    const pipe = new ZodValidationPipe(schema);

    const withSomeEmpty = pipe.transform({ tags: ['a', '', 'b'] }, queryMeta());
    expect(withSomeEmpty).toEqual({ tags: ['a', 'b'] });

    const allEmpty = pipe.transform({ tags: ['', ''] }, queryMeta());
    expect(allEmpty).toEqual({});
  });

  it('query cleanup NIE mutuje oryginalny obiekt (Express 5 req.query jest getterem)', () => {
    const schema = z.strictObject({ kind: z.string().optional() });
    const pipe = new ZodValidationPipe(schema);
    const original = { kind: '' };
    const originalRef = original;

    pipe.transform(original, queryMeta());

    expect(original).toBe(originalRef);
    expect(original).toEqual({ kind: '' }); // nietknięty, mimo że pipe zbudował nowy obiekt do parsowania
  });

  it('komunikat NIGDY nie niesie surowej wartości usera (bez reportInput)', () => {
    const schema = z.strictObject({ kind: z.enum(['fact', 'document']) });
    const pipe = new ZodValidationPipe(schema);
    const distinctiveSecret = 'SUPER-SEKRETNA-WARTOSC-UZYTKOWNIKA-XYZ123';

    try {
      pipe.transform({ kind: distinctiveSecret }, queryMeta());
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).message).not.toContain(distinctiveSecret);
    }
  });

  it('cap na 5 błędów -> reszta zliczona w "(+N more)"', () => {
    const schema = z.strictObject({
      a: z.enum(['x']),
      b: z.enum(['x']),
      c: z.enum(['x']),
      d: z.enum(['x']),
      e: z.enum(['x']),
      f: z.enum(['x']),
      g: z.enum(['x']),
    });
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ a: 'n', b: 'n', c: 'n', d: 'n', e: 'n', f: 'n', g: 'n' }, queryMeta());
      expect.unreachable();
    } catch (err) {
      const message = (err as ToolError).message;
      expect(message).toContain('(+2 more)');
      // Dokładnie 5 segmentów widocznych + jeden overflow — sanity check na format, nie tylko obecność.
      expect(message.split('; ').length).toBe(5);
    }
  });
});
