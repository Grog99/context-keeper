/** Buduje query string dla `GET /api/*` (§M4) — pomija `undefined`/pusty string; wspiera wielokrotne
 * wartości (np. `tags`) przez tablicę. Osobny plik od `lib/api.ts` (M2) — celowo addytywny, bez
 * dotykania istniejącego fetch-wrappera Stage A. */
export function toQueryString(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) if (v) search.append(key, v);
    } else if (value !== '') {
      search.set(key, value);
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}
