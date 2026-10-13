import { cn } from '../lib/utils';

/**
 * §8.2 design-systemu — znak aplikacji „zapieczętowana księga z dziurką od klucza". Inline SVG na
 * siatce 64×64; kolory wyłącznie z tokenów `--brand-*` (§2.5, `globals.css`), więc wariant
 * jasny/ciemny idzie za `data-theme` (a bez niego za `prefers-color-scheme`) jak reszta UI.
 *
 * Geometria jest zdublowana w `public/favicon.svg` (statyczny, ze swoim `@media` dark) — zmiana
 * znaku zmienia oba pliki i wymaga regeneracji rastrów (`favicon.ico`, `apple-touch-icon.png`).
 * Dekoracyjny (`aria-hidden`): zawsze stoi obok tekstu „Context Keeper"; rozmiar podaje konsument.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={cn('shrink-0', className)}>
      <rect x="2" y="2" width="60" height="60" rx="14" className="fill-[var(--brand-tile)]" />
      <rect x="15" y="11" width="34" height="42" rx="3" className="fill-[var(--brand-paper)]" />
      <rect x="20" y="11" width="5" height="42" className="fill-[var(--brand-tile)]" />
      <rect x="25" y="28" width="24" height="8" className="fill-[var(--brand-seal)]" />
      <circle cx="37.5" cy="32" r="11" className="fill-[var(--brand-seal)]" />
      <circle cx="37.5" cy="29.792" r="2.76" className="fill-[var(--brand-paper)]" />
      <path d="M35.936 31.08h3.128l1.104 5.98h-5.336z" className="fill-[var(--brand-paper)]" />
    </svg>
  );
}
