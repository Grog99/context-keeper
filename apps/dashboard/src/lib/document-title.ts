/** Nazwa aplikacji — koniec każdego tytułu karty; także statyczny `<title>` w `index.html`. */
export const APP_TITLE = 'Context Keeper';

/** Nazwa ekranu logowania w tytule karty (§9.12) — ekran stoi poza railem, więc nie ma labela w nawigacji. */
export const LOGIN_SCREEN_TITLE = 'Logowanie';

/**
 * §9.0 design-systemu — tytuł karty „(N) ‹Ekran› · Context Keeper". Licznik `(N) ` tylko przy
 * `queueDepth > 0` (ta sama reguła co badge Kolejki w railu); bez ekranu zostaje „(N) Context Keeper".
 */
export function documentTitle(screen: string | null, queueDepth?: number): string {
  const counter = queueDepth !== undefined && queueDepth > 0 ? `(${queueDepth}) ` : '';
  const screenPart = screen ? `${screen} · ` : '';
  return `${counter}${screenPart}${APP_TITLE}`;
}

/**
 * Label pozycji railu dla bieżącej ścieżki: dokładne dopasowanie albo ścieżka zagnieżdżona pod
 * pozycją (`/pamiec/mem_x` → „Pamięć"); `/pamiecx` ani nieznana ścieżka nie pasują → `null`.
 */
export function screenLabelForPath(
  pathname: string,
  items: readonly { to: string; label: string }[],
): string | null {
  const item = items.find(({ to }) => pathname === to || pathname.startsWith(`${to}/`));
  return item ? item.label : null;
}
