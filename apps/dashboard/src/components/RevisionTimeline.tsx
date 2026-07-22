import { formatAbsoluteTime, formatRelativeTime } from '../lib/format';
import { cn } from '../lib/utils';
import type { RevisionAction } from '../types/domain';
import { MonoId } from './MonoId';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const ACTION_LABEL: Record<RevisionAction, string> = {
  created: 'Utworzono',
  edited: 'Edytowano',
  promote: 'Promowano do global',
  archive: 'Zarchiwizowano',
  superseded_by: 'Zastąpione przez',
};

export interface RevisionItem {
  id: string;
  action: RevisionAction;
  actor: string;
  createdAt: string;
  supersedes?: string | null;
  supersededBy?: string | null;
}

/** §8.2 — pionowa oś w detalu pamięci: `rev_…` (mono), autor, czas, akcja. Supersession linkuje do
 * zamiennika. Zakłada `revisions` posortowane malejąco (najnowsza pierwsza = "now"). */
export interface RevisionTimelineProps {
  revisions: RevisionItem[];
  onSelectMemory?: (id: string) => void;
}

export function RevisionTimeline({ revisions, onSelectMemory }: RevisionTimelineProps) {
  if (revisions.length === 0) {
    return <p className="text-xs text-faint">Brak rewizji.</p>;
  }

  return (
    <ol className="relative m-0 list-none pl-5">
      <span className="absolute bottom-1 left-[5px] top-1 w-px bg-border" aria-hidden />
      {revisions.map((rev, index) => (
        <li key={rev.id} className="relative pb-4 last:pb-0">
          <span
            className={cn(
              'absolute -left-5 top-[3px] size-[9px] rounded-full border-2 bg-surface',
              index === 0 ? 'border-primary bg-primary' : 'border-border-strong',
            )}
            aria-hidden
          />
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            {ACTION_LABEL[rev.action]}
            <MonoId value={rev.id} />
            {rev.supersedes && (
              <span className="font-mono text-xs text-faint">
                ← zastępuje{' '}
                <button
                  type="button"
                  onClick={() => onSelectMemory?.(rev.supersedes!)}
                  className="underline decoration-dotted hover:decoration-solid"
                >
                  {rev.supersedes}
                </button>
              </span>
            )}
            {rev.supersededBy && (
              <span className="font-mono text-xs text-faint">
                →{' '}
                <button
                  type="button"
                  onClick={() => onSelectMemory?.(rev.supersededBy!)}
                  className="underline decoration-dotted hover:decoration-solid"
                >
                  {rev.supersededBy}
                </button>
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {rev.actor} ·{' '}
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{formatRelativeTime(rev.createdAt)}</span>
              </TooltipTrigger>
              <TooltipContent>{formatAbsoluteTime(rev.createdAt)}</TooltipContent>
            </Tooltip>
          </div>
        </li>
      ))}
    </ol>
  );
}
