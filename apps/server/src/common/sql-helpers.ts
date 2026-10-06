import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * `col = ANY($1::text[])` z JEDNYM parametrem bind (tablica) — zamiast `inArray`, które Drizzle
 * rozwija na `($1,$2,…,$N)`, czyli N osobnych parametrów (twardy sufit 65 535 w Postgresie, plus
 * koszt O(N) w planowaniu/transferze). Surowa tablica JS wstawiona w szablon `sql` też rozwinęłaby
 * się na wiele parametrów — dlatego `sql.param(ids)`. Pusta tablica -> `false` (zero wierszy), jak
 * `inArray(col, [])`.
 */
export function idsAny(column: AnyColumn, ids: readonly string[]): SQL {
  return sql`${column} = any(${sql.param([...ids])}::text[])`;
}
