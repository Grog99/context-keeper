import type { UsageBucket } from '../types/api';

/** Pomocnicze (nie-komponentowe) fragmenty `components/UsageChart.tsx`, wydzielone do osobnego pliku
 * — `react-refresh/only-export-components` (Vite fast refresh) wymaga, żeby plik komponentu
 * eksportował WYŁĄCZNIE komponenty (patrz `eslint.config.mjs`, wyjątek istnieje tylko dla
 * `components/ui/**`/`lib/context.tsx`, nie dla tego pliku). */

/** Paleta kategoryczna dla serii "per projekt" — WYŁĄCZNIE tokeny design-systemu (żadnych hex na
 * sztywno, §5(h) planu), więc jasny/ciemny motyw działają bez zmian tutaj. Semantyka kolorów
 * statusowych (success/warning/danger) jest tu celowo NIEISTOTNA — traktujemy je jako zwykłą
 * kategoryczną paletę cykliczną, nie jako "dobry/zły projekt". */
const PROJECT_PALETTE = [
  'var(--primary)',
  'var(--success)',
  'var(--warning)',
  'var(--danger)',
  'var(--neutral)',
  'var(--primary-hover)',
] as const;

/** Kolor per projekt, deterministyczny (indeks po posortowanej liście id, NIE po kolejności wejścia)
 * — ten sam projekt dostaje ten sam kolor w każdym panelu ekranu Pomiary, niezależnie od tego, który
 * panel renderuje się pierwszy. */
export function assignProjectColors(projectIds: string[]): Map<string, string> {
  const sorted = [...projectIds].sort();
  return new Map(sorted.map((id, i) => [id, PROJECT_PALETTE[i % PROJECT_PALETTE.length]]));
}

export function formatBucketLabel(ts: string, bucket: UsageBucket): string {
  const d = new Date(ts);
  return bucket === 'hour'
    ? d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' });
}

/** Wspólny theming tooltipa/osi recharts przez CSS variables (§5(h) — dark mode bez zmian w JS). */
export const AXIS_TICK = { fill: 'var(--muted-foreground)', fontSize: 11 };
export const AXIS_LINE = { stroke: 'var(--border)' };
export const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 12,
  boxShadow: 'var(--shadow-sm)',
};
export const LEGEND_STYLE = { fontSize: 11, color: 'var(--muted-foreground)' };
