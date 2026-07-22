import { Sparkles } from 'lucide-react';

/** §8.2 — advisory, NIE blokuje (FR-M3). `info` alert inline pod headerem. */
export interface DedupHintProps {
  similarIds: string[];
  onSelect?: (id: string) => void;
}

export function DedupHint({ similarIds, onSelect }: DedupHintProps) {
  if (similarIds.length === 0) return null;

  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-md border border-info bg-info-subtle px-3 py-2.5 text-xs text-info-foreground">
      <Sparkles className="mt-0.5 size-[15px] shrink-0 text-info" />
      <p>
        Podobne istniejące pamięci:{' '}
        {similarIds.map((id, i) => (
          <span key={id}>
            <button
              type="button"
              onClick={() => onSelect?.(id)}
              className="font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {id}
            </button>
            {i < similarIds.length - 1 ? ', ' : ''}
          </span>
        ))}
        . Advisory — propozycja i tak powstała (embedding nie odróżnia korekty od duplikatu).
      </p>
    </div>
  );
}
