import { Clock, FileText, Notebook, ScrollText } from 'lucide-react';
import { cn } from '../lib/utils';
import type { MemoryKind } from '../types/domain';

/**
 * §2.3 design-systemu — **kolor tożsamości**, nie statusu. `kind` niesie trzy redundantne kanały:
 * kształt (gutter przy krawędzi wiersza), ikonę i kolor. Kolor jest tu kanałem TRZECIM — wyłączenie
 * go zostawia działające rozróżnienie, co jest wymogiem P2 (kolor nigdy nie jest jedynym sygnałem).
 *
 * Hue (`--kind-*` w `globals.css`) leżą świadomie w martwych strefach koła — petrol ~198°, wrzos
 * ~312° i oliwka ~90° (`journal`, v1.8) nie sąsiadują z żadnym znaczeniem z §2.2 (zieleń 142°
 * (status) i ~150° (akcent), bursztyn 35°, czerwień 5°), więc nie da się ich odczytać jako status.
 * Oliwka jest najbliżej zieleni — dlatego `journal` ma też najmocniej odmienny kształt (podwójna
 * linia) i ikonę (`ScrollText`). Niska chroma jest częścią kontraktu: te kolory mają
 * czytać się jak barwiony papier, nie jak sygnał. `fact` NIE ma koloru — jako najczęstszy kind
 * zostaje neutralną bazą, od której odcinają się pozostałe.
 */

const ICON: Record<MemoryKind, typeof FileText> = {
  fact: Notebook,
  document: FileText,
  event: Clock,
  journal: ScrollText,
};

/** Pasek przy lewej krawędzi wiersza — nośnik KSZTAŁTU: brak / pełny / kropkowany / podwójna linia.
 * Nieeksportowany celowo: `react-refresh/only-export-components` wymaga, żeby plik komponentu
 * eksportował wyłącznie komponenty — konsumenci biorą `<KindGutter/>`, nie samą mapę klas. */
const KIND_GUTTER: Record<MemoryKind, string> = {
  fact: 'bg-transparent',
  document: 'bg-[var(--kind-document)]',
  event: 'bg-[repeating-linear-gradient(180deg,var(--kind-event)_0_3px,transparent_3px_6px)]',
  // Podwójna linia 1px + 1px + 1px ("Ruled ledger"): 1px kreska, 1px przerwa, 1px kreska.
  journal: 'bg-[linear-gradient(90deg,var(--kind-journal)_0_1px,transparent_1px_2px,var(--kind-journal)_2px_3px)]',
};

// Modyfikator opacity (`/45`) NIE działa na kolor podany jako `var()` — Tailwind potrzebuje kanałów
// `r g b`, żeby wstrzyknąć alfę, i przy `var()` cicho spada do `--border`. Stąd jawny `color-mix`.
const MARKER: Record<MemoryKind, string> = {
  fact: 'border-border-strong bg-muted text-muted-foreground',
  document:
    'border-[color-mix(in_srgb,var(--kind-document)_45%,transparent)] bg-[var(--kind-document-subtle)] text-[var(--kind-document-foreground)]',
  event:
    'border-[color-mix(in_srgb,var(--kind-event)_45%,transparent)] bg-[var(--kind-event-subtle)] text-[var(--kind-event-foreground)]',
  journal:
    'border-[color-mix(in_srgb,var(--kind-journal)_45%,transparent)] bg-[var(--kind-journal-subtle)] text-[var(--kind-journal-foreground)]',
};

/** Gutter renderowany jako absolutnie pozycjonowany pasek — wiersz musi mieć `relative` i lewy padding. */
export function KindGutter({ kind }: { kind: MemoryKind }) {
  return <span className={cn('absolute inset-y-0 left-0 w-[3px]', KIND_GUTTER[kind])} aria-hidden />;
}

/** Kwadratowy marker 22px: ikona kind w tincie tożsamości. Label niesie `sr-only` (P2 — kolor i
 * kształt są dla wzroku, screen reader dostaje słowo).
 *
 * `decorative` dla miejsc, gdzie nazwa kind stoi już jako widoczny tekst obok markera (pasek
 * metadanych detalu) — bez tego screen reader czyta „document document". */
export function KindMarker({
  kind,
  decorative = false,
  className,
}: {
  kind: MemoryKind;
  decorative?: boolean;
  className?: string;
}) {
  const Icon = ICON[kind];
  return (
    <span
      className={cn('flex size-[22px] items-center justify-center rounded-sm border', MARKER[kind], className)}
      aria-hidden={decorative || undefined}
    >
      <Icon className="size-3.5" aria-hidden />
      {!decorative && <span className="sr-only">{kind}</span>}
    </span>
  );
}
