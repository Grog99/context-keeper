import { ArrowLeftRight, GitMerge, Plus, Trash2 } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { formatRelativeTime } from '../lib/format';
import { cn } from '../lib/utils';
import type { MemoryScope, ProposalOrigin, ProposalType } from '../types/domain';
import { OriginPath } from './OriginPath';
import { StatusChip, type StatusChipStatus } from './StatusChip';

const TYPE_ICON: Record<ProposalType, typeof Plus> = {
  create: Plus,
  update: ArrowLeftRight,
  merge: GitMerge,
  delete: Trash2,
};

const MAX_VISIBLE_TAGS = 2;

/** §8.2/§9.1 — wiersz kolejki `min-h-[56px]` (makieta `.row`): `[StatusChip] [type ikona] Header
 * (truncate) … [OriginPath] [tagi ≤2 + "+N"] [czas rel.]`. Stale → dodatkowy `danger` badge po
 * prawej. Hover `surface-muted`, aktywny `accent-subtle` + lewy pasek 2px iris. */
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

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-selected={selected}
      className={cn(
        'relative grid min-h-[56px] cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2.5 border-b border-border px-3.5 py-2.5',
        'hover:bg-muted focus-visible:outline-none',
        selected && 'bg-accent-subtle',
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-[2px] bg-primary" aria-hidden />}
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
  );
}
