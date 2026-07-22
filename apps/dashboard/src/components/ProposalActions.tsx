import { Check, ChevronDown, Lock, Pencil, Replace, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export interface SupersedeCandidate {
  id: string;
  header: string;
}

function SupersedeSplitButton({
  onSelect,
  search,
  disabled,
}: {
  onSelect: (id: string) => void;
  search?: (query: string) => Promise<SupersedeCandidate[]>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SupersedeCandidate[]>([]);
  const [loading, setLoading] = useState(false);

  async function handleQueryChange(value: string) {
    setQuery(value);
    if (!search || value.trim().length === 0) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      setResults(await search(value));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" disabled={disabled} className="pr-2.5">
          <Replace className="size-[15px]" /> Zatwierdź jako zamiennik
          <kbd className="ml-0.5 rounded border border-current px-1 text-[10px] opacity-70">S</kbd>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        {/* `shouldFilter=false` — wyszukiwanie async po stronie rodzica (Q8: "search/typeahead,
            bez precomputed listy"), nie lokalny filtr cmdk nad statyczną listą. */}
        <Command shouldFilter={false}>
          <CommandInput placeholder="Szukaj pamięci do zastąpienia…" value={query} onValueChange={handleQueryChange} />
          <CommandList>
            <CommandEmpty>{loading ? 'Szukam…' : 'Brak wyników.'}</CommandEmpty>
            <CommandGroup>
              {results.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  onSelect={() => {
                    onSelect(candidate.id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{candidate.header}</span>
                  <span className="ml-auto shrink-0 font-mono text-xs text-faint">{candidate.id}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export interface ProposalActionsProps {
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
  onApproveAsReplacement: (targetId: string) => void;
  /** Wyszukiwanie kandydatów do supersession (§8.2, Q8 planu) — bez precomputed listy. */
  searchSupersedeCandidates?: (query: string) => Promise<SupersedeCandidate[]>;
  stale?: boolean;
  staleReason?: string;
  busy?: boolean;
  /** "1 / N" — pozycja w liście (spring po prawej, jak w makiecie). */
  position?: string;
}

/** §8.2 — sticky bar u dołu detalu: Zatwierdź(A)/Odrzuć(R)/Edytuj(E)/split-button "…jako
 * zamiennik"(S). Przy `stale` → primary disabled + inline alert z powodem. */
export function ProposalActions({
  onApprove,
  onReject,
  onEdit,
  onApproveAsReplacement,
  searchSupersedeCandidates,
  stale,
  staleReason,
  busy,
  position,
}: ProposalActionsProps) {
  return (
    <div className="flex flex-none flex-col border-t border-border bg-surface">
      {stale && (
        <div className="mx-6 mt-3 flex items-start gap-2.5 rounded-md border border-danger bg-danger-subtle px-3 py-2.5 text-xs text-danger-foreground">
          <Lock className="mt-0.5 size-4 shrink-0 text-danger" />
          <div>
            <b className="font-semibold">Stale — bazowa rewizja się zmieniła.</b>{' '}
            {staleReason ??
              'Ta propozycja liczona była względem starszego stanu. Approve zablokowany (optimistic concurrency). Przejrzyj różnicę lub zaktualizuj bazę ręcznie.'}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 px-6 py-3">
        <Button variant="primary" disabled={stale || busy} onClick={onApprove}>
          <Check className="size-[15px]" /> Zatwierdź
          <kbd className="ml-0.5 rounded border border-current px-1 text-[10px] opacity-70">A</kbd>
        </Button>
        <Button variant="ghost-danger" disabled={busy} onClick={onReject}>
          <X className="size-[15px]" /> Odrzuć
          <kbd className="ml-0.5 rounded border border-current px-1 text-[10px] opacity-70">R</kbd>
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onEdit}>
          <Pencil className="size-[15px]" /> Edytuj
          <kbd className="ml-0.5 rounded border border-current px-1 text-[10px] opacity-70">E</kbd>
        </Button>
        <SupersedeSplitButton onSelect={onApproveAsReplacement} search={searchSupersedeCandidates} disabled={busy} />
        {position && <span className="ml-auto font-mono text-[11px] text-faint">{position}</span>}
      </div>
    </div>
  );
}
