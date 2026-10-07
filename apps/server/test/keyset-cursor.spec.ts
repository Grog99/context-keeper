import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetAfter,
  pageByKeyset,
} from '../src/common/keyset-cursor';
import { idsAny } from '../src/common/sql-helpers';

const TS = '2026-10-06T12:34:56.123456Z';
const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

describe('keyset-cursor', () => {
  it('round trip: encode -> decode zwraca tę samą pozycję', () => {
    const pos = { ts: TS, id: 'evt_a1b2c3d4e5f6' };
    expect(decodeKeysetCursor(encodeKeysetCursor(pos))).toEqual(pos);
  });

  it.each([
    ['pusty string', ''],
    ['śmieciowy base64', '!!!not-base64!!!'],
    ['base64 nie-JSON', b64('to nie jest json')],
    ['JSON nie-tablica', b64({ ts: TS, id: 'x' })],
    ['zła arność (1)', b64([TS])],
    ['zła arność (3)', b64([TS, 'x', 'y'])],
    ['złe typy (id liczba)', b64([TS, 5])],
    ['złe typy (ts null)', b64([null, 'x'])],
    ['ISO z milisekundami', b64(['2026-10-06T12:34:56.123Z', 'x'])],
    ['ISO bez ułamka', b64(['2026-10-06T12:34:56Z', 'x'])],
    ['offset zamiast Z', b64(['2026-10-06T12:34:56.123456+02:00', 'x'])],
    ['miesiąc 13', b64(['2026-13-06T12:34:56.123456Z', 'x'])],
    ['miesiąc 00', b64(['2026-00-06T12:34:56.123456Z', 'x'])],
    ['dzień 45', b64(['2026-10-45T12:34:56.123456Z', 'x'])],
    ['30 lutego', b64(['2026-02-30T12:34:56.123456Z', 'x'])],
    ['29 lutego w roku nieprzestępnym', b64(['2026-02-29T12:34:56.123456Z', 'x'])],
    ['godzina 25', b64(['2026-10-06T25:34:56.123456Z', 'x'])],
    ['minuta 61', b64(['2026-10-06T12:61:56.123456Z', 'x'])],
    ['sekunda 61', b64(['2026-10-06T12:34:61.123456Z', 'x'])],
    ['rok 0000', b64(['0000-10-06T12:34:56.123456Z', 'x'])],
    ['wszystko niepoprawne naraz', b64(['2026-13-45T25:61:61.000000Z', 'abc'])],
    ['id ze spacją', b64([TS, 'a b'])],
    ['id z apostrofem', b64([TS, "x'; drop table"])],
    ['id pusty', b64([TS, ''])],
    ['id za długi (65)', b64([TS, 'a'.repeat(65)])],
    ['zbyt długi input', 'A'.repeat(257)],
  ])('odrzuca: %s', (_label, raw) => {
    expect(decodeKeysetCursor(raw)).toBeNull();
  });

  it.each([
    ['przestępny 29 lutego', '2028-02-29T00:00:00.000000Z'],
    ['koniec doby', '2026-12-31T23:59:59.999999Z'],
    ['początek doby', '2026-01-01T00:00:00.000001Z'],
  ])('akceptuje poprawną datę (%s) i zachowuje ts bez zmian', (_label, ts) => {
    expect(decodeKeysetCursor(b64([ts, 'evt_x']))).toEqual({ ts, id: 'evt_x' });
  });

  it('keysetAfter używa bind params i porównania wierszowego (asc/desc)', () => {
    const dialect = new PgDialect();
    const pos = { ts: TS, id: 'evt_x' };
    const asc = dialect.sqlToQuery(keysetAfter(auditLog, pos, 'asc'));
    const desc = dialect.sqlToQuery(keysetAfter(auditLog, pos, 'desc'));
    expect(asc.sql).toContain('> ($1::timestamptz, $2)');
    expect(desc.sql).toContain('< ($1::timestamptz, $2)');
    expect(asc.params).toEqual([TS, 'evt_x']);
  });

  it('pageByKeyset: nadmiarowy wiersz -> nextCursor z OSTATNIEGO zwróconego, bez cursorTs', () => {
    const rows = [
      { id: 'a', cursorTs: '2026-01-01T00:00:00.000001Z', v: 1 },
      { id: 'b', cursorTs: '2026-01-01T00:00:00.000002Z', v: 2 },
      { id: 'c', cursorTs: '2026-01-01T00:00:00.000003Z', v: 3 },
    ];
    const page = pageByKeyset(rows, 2);
    expect(page.items).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ]);
    expect(decodeKeysetCursor(page.nextCursor!)).toEqual({ ts: '2026-01-01T00:00:00.000002Z', id: 'b' });
    expect(pageByKeyset(rows, 3).nextCursor).toBeNull();
    expect(pageByKeyset([], 3)).toEqual({ items: [], nextCursor: null });
  });
});

describe('idsAny', () => {
  it('niesie całą tablicę jako JEDEN parametr bind (nie N)', () => {
    const dialect = new PgDialect();
    const ids = Array.from({ length: 500 }, (_, i) => `mem_${i}`);
    const q = dialect.sqlToQuery(idsAny(auditLog.id, ids));
    expect(q.params).toHaveLength(1);
    expect(q.params[0]).toEqual(ids);
    expect(q.sql).toContain('= any($1::text[])');
  });
});
