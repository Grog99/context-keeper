import { ArrowLeftRight, GitMerge, Plus, Trash2 } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { formatRelativeTime } from '../lib/format';
import { cn } from '../lib/utils';
import type { MemoryScope, ProposalOrigin, ProposalType } from '../types/domain';
import { OriginPath } from './OriginPath';
import { StatusChip, type StatusChipStatus } from './StatusChip';
import { Checkbox } from './ui/checkbox';

const TYPE_ICON: Record<ProposalType, typeof Plus> = {
  create: Plus,
  update: ArrowLeftRight,
  merge: GitMerge,
  delete: Trash2,
};

const MAX_VISIBLE_TAGS = 2;

/**
 * §8.2/§9.1 — wiersz kolejki `min-h-[56px]` (makieta `.row`): [checkbox opcjonalny] [StatusChip]
 * [type ikona] Header (truncate) … [OriginPath] [tagi ≤2 + "+N"] [czas rel.]. Stale → dodatkowy
 * `danger` badge po prawej. Hover `surface-muted`, aktywny `accent-subtle` + lewy pasek 2px iris.
 *
 * DOM restrukturyzowany dla bulk selection (roadmap v1.3, "Bulk approve/reject w kolejce"): zewnętrzny
 * `div` NIE jest już `role="button"` (a11y — element interaktywny zagnieżdżony w innym interaktywnym
 * jest niepoprawny; checkbox musi żyć POZA klikalnym obszarem, nie wewnątrz niego). Klikalny obszar
 * treści (StatusChip/tytuł/meta/czas) to osobny wewnętrzny `div role="button"`; checkbox ma własną
 * komórkę grida ze `stopPropagation()` — klik w checkbox przełącza zaznaczenie, NIGDY nie otwiera
 * podglądu, i odwrotnie. Hover na całym wierszu (w tym nad checkboxem) podświetla tło — świadome,
 * checkbox i treść to wciąż wizualnie jeden wiersz.
 */
export interface ProposalRowProps {
  type: ProposalType;
  status: StatusChipStatus;
  title: string;
  origin: ProposalOrigin;
  scope: MemoryScope;
  projectName?: string | null;
  tags: string[];
  createdAt: string;
  stale?: boolean;
  selected?: boolean;
  onClick?: () => void;
  /** Bulk selection (roadmap v1.3) — `checked`/`onCheckedChange` mają sens wyłącznie gdy `true`.
   * Propsy opcjonalne i domyślnie nieaktywne — `DevPreviewScreen` i inne konsumenty bez zmian. */
  selectable?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export function ProposalRow({
  type,
  status,
  title,
  origin,
  scope,
  projectName,
  tags,
  createdAt,
  stale,
  selected,
  onClick,
  selectable,
  checked,
  onCheckedChange,
}: ProposalRowProps) {
  const Icon = TYPE_ICON[type];
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenCount = tags.length - visibleTags.length;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  }

  function handleCheckboxCellClick(event: MouseEvent<HTMLDivElement>) {
    // Komórka checkboxa leży POZA `role="button"` treści (patrz komentarz interfejsu), więc to
    // `stopPropagation` dziś nie ma czego zatrzymywać — zostaje jako strażnik na przyszłość, gdyby
    // ktoś kiedyś dołożył `onClick` na zewnętrznym `div` (regresja "klik w checkbox otwiera podgląd").
    event.stopPropagation();
  }

  return (
    <div
      className={cn(
        'relative grid min-h-[56px] items-stretch border-b border-border',
        selectable ? 'grid-cols-[auto_1fr]' : 'grid-cols-1',
        'hover:bg-muted',
        selected && 'bg-accent-subtle',
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-[2px] bg-primary" aria-hidden />}
      {selectable && (
        <div className="flex items-center pl-3.5 pr-1" onClick={handleCheckboxCellClick}>
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => onCheckedChange?.(value === true)}
            aria-label={`Zaznacz propozycję: ${title}`}
          />
        </div>
      )}
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        aria-selected={selected}
        className={cn(
          'grid min-w-0 cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2.5 py-2.5 pr-3.5',
          selectable ? 'pl-2' : 'pl-3.5',
          'focus-visible:outline-none',
        )}
      >
        <StatusChip status={status} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-1.5 truncate text-[13.5px] font-medium text-foreground">
            <Icon className="size-3.5 shrink-0 text-faint" />
            <span className="truncate">{title}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2.5">
            <OriginPath origin={origin} scope={scope} projectName={projectName} />
            {tags.length > 0 && (
              <span className="flex min-w-0 gap-1">
                {visibleTags.map((tag) => (
                  <span
                    key={tag}
                    className="whitespace-nowrap rounded-[4px] border border-border bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
                {hiddenCount > 0 && (
                  <span className="whitespace-nowrap rounded-[4px] border border-border bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                    +{hiddenCount}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="whitespace-nowrap font-mono text-[11px] text-faint">{formatRelativeTime(createdAt)}</span>
          {stale && <StatusChip status="stale" />}
        </div>
      </div>
    </div>
  );
}
