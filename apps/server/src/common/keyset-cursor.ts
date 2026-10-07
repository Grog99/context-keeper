import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * Wspólny kursor keyset `(created_at, id)` w PEŁNEJ precyzji (nightly-scale G6, ustalenie 7) — dla
 * `GET /api/audit` i `GET /api/proposals`. Wzorzec „ISO `createdAt` ostatniego wiersza" gubił wiersze:
 * `Date` ucina mikrosekundy Postgresa, a kilka wpisów z jednej transakcji ma identyczne `now()`.
 *
 * `ts` jest kanonicznym stringiem UTC z mikrosekundami (`YYYY-MM-DDTHH:MM:SS.ffffffZ`) produkowanym
 * PRZEZ SQL (`keysetTs`), nigdy przez JS-owy `Date`. Kursor wychodzi do klienta jako opaque base64url
 * i wraca jako attacker-controlled input — `decodeKeysetCursor` waliduje oba człony ściśle, a
 * `keysetAfter` wkłada je wyłącznie jako bind params.
 */
export interface KeysetPosition {
  ts: string;
  id: string;
}

const KEYSET_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const KEYSET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Twardy sufit długości surowego kursora — realny kursor ma ~100 znaków. */
const KEYSET_CURSOR_MAX_LEN = 256;

/** Kolumna `timestamptz` -> kanoniczny string UTC z mikrosekundami. NIE `created_at::text` (zależy
 * od `DateStyle`/`TimeZone` sesji) i NIE `extract(epoch …)` (float traci mikrosekundy). Format
 * statyczny — nic z wejścia użytkownika nie trafia do tego fragmentu SQL. */
export function keysetTs(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Czy `ts` (już po `KEYSET_TS_RE`) jest poprawną datą kalendarzową (miesiąc 13, 30 lutego, godzina 25
 * itd. przeszłyby regex, a Postgres rzuciłby 22008 na `::timestamptz` -> 500 zamiast 400). Weryfikacja
 * round-tripem przez `Date` — używamy go TYLKO do sprawdzenia składników (mikrosekundy ignorujemy);
 * wartość kursora zostaje oryginalnym stringiem. Rok 0000 odrzucamy: Postgres nie ma roku 0. */
function isValidKeysetTimestamp(ts: string): boolean {
  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(5, 7));
  const day = Number(ts.slice(8, 10));
  const hour = Number(ts.slice(11, 13));
  const minute = Number(ts.slice(14, 16));
  const second = Number(ts.slice(17, 19));
  if (year < 1) return false;
  const d = new Date(0);
  // setUTCFullYear (nie Date.UTC): Date.UTC mapuje lata 0-99 na 1900-1999.
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day &&
    d.getUTCHours() === hour &&
    d.getUTCMinutes() === minute &&
    d.getUTCSeconds() === second
  );
}

export function encodeKeysetCursor(pos: KeysetPosition): string {
  return Buffer.from(JSON.stringify([pos.ts, pos.id])).toString('base64url');
}

/** `null` dla każdego wejścia, które nie jest dokładnie kursorem z `encodeKeysetCursor` (śmieciowy
 * base64, nie-JSON, zła arność/typy, ISO z milisekundami, offset inny niż `Z`, niepoprawna data
 * kalendarzowa, znaki spoza `[A-Za-z0-9_-]` w `id`, zbyt długi input). Nigdy nie rzuca. */
export function decodeKeysetCursor(raw: string): KeysetPosition | null {
  if (raw.length === 0 || raw.length > KEYSET_CURSOR_MAX_LEN) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [ts, id] = parsed as unknown[];
  if (typeof ts !== 'string' || typeof id !== 'string') return null;
  if (!KEYSET_TS_RE.test(ts) || !KEYSET_ID_RE.test(id)) return null;
  if (!isValidKeysetTimestamp(ts)) return null;
  return { ts, id };
}

/** Warunek „po kursorze" jako porównanie wierszowe — `'asc'`: `(created_at, id) > cursor`, `'desc'`:
 * `<`. Wartości wyłącznie jako bind params (`ts` rzutowany na `timestamptz`, żeby porównanie szło po
 * pełnej precyzji, nie po tekście). */
export function keysetAfter(
  cols: { createdAt: AnyColumn; id: AnyColumn },
  pos: KeysetPosition,
  direction: 'asc' | 'desc',
): SQL {
  return direction === 'asc'
    ? sql`(${cols.createdAt}, ${cols.id}) > (${pos.ts}::timestamptz, ${pos.id})`
    : sql`(${cols.createdAt}, ${cols.id}) < (${pos.ts}::timestamptz, ${pos.id})`;
}

/** Wspólna logika paginacji `limit + 1`: przycina nadmiarowy wiersz i liczy `nextCursor` z OSTATNIEGO
 * zwróconego elementu (nie z nadmiarowego). `cursorTs` jest zdejmowane z elementów odpowiedzi. */
export function pageByKeyset<T extends { id: string; cursorTs: string }>(
  rows: T[],
  limit: number,
): { items: Omit<T, 'cursorTs'>[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const items = pageRows.map(({ cursorTs: _cursorTs, ...rest }) => rest);
  return {
    items,
    nextCursor: hasMore && last ? encodeKeysetCursor({ ts: last.cursorTs, id: last.id }) : null,
  };
}
