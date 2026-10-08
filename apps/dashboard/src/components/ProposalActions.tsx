import { ArrowLeftRight, Check, ChevronDown, Lock, Pencil, Replace, X } from 'lucide-react';
import { useState } from 'react';
import type { MemoryScope } from '../types/domain';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export interface SupersedeCandidate {
  id: string;
  header: string;
  /** Zasięg kandydata — `global` dostaje znaczek (zamiennik pamięci globalnej dotyczy wszystkich projektów). */
  scope?: MemoryScope;
}

/** Wiersz kandydata — wspólny dla wyników wyszukiwania i grupy „Podobne (podpowiedź)". */
function SupersedeCandidateItem({ candidate, onPick }: { candidate: SupersedeCandidate; onPick: () => void }) {
  return (
    <CommandItem value={candidate.id} onSelect={onPick}>
      <span className="min-w-0 flex-1 truncate">{candidate.header}</span>
      {candidate.scope === 'global' && <Badge variant="neutral" className="h-[18px] shrink-0 px-1.5">global</Badge>}
      <span className="ml-auto shrink-0 font-mono text-xs text-faint">{candidate.id}</span>
    </CommandItem>
  );
}

function SupersedeSplitButton({
  onSelect,
  search,
  suggested,
  disabled,
}: {
  onSelect: (id: string) => void;
  search?: (query: string) => Promise<SupersedeCandidate[]>;
  /** Pamięci z podpowiedzi A1 — widoczne bez wpisywania frazy (dopóki pole wyszukiwania jest puste). */
  suggested?: SupersedeCandidate[];
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

  function pick(id: string) {
    onSelect(id);
    setOpen(false);
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
            {query.trim() === '' && suggested && suggested.length > 0 && (
              <CommandGroup heading="Podobne (podpowiedź)">
                {suggested.map((candidate) => (
                  <SupersedeCandidateItem key={candidate.id} candidate={candidate} onPick={() => pick(candidate.id)} />
                ))}
              </CommandGroup>
            )}
            <CommandGroup>
              {results.map((candidate) => (
                <SupersedeCandidateItem key={candidate.id} candidate={candidate} onPick={() => pick(candidate.id)} />
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
  /** Kandydaci z podpowiedzi „podobne do istniejących" (A1) — grupa „Podobne" na górze listy, bez wpisywania frazy. */
  supersedeSuggestions?: SupersedeCandidate[];
  stale?: boolean;
  staleReason?: string;
  busy?: boolean;
  /** "1 / N" — pozycja w liście (spring po prawej, jak w makiecie). */
  position?: string;
  /** `false` ukrywa "Edytuj" (typ bez treści do edycji, np. `create_project`) — `lib/proposals.ts`. */
  canEdit?: boolean;
  /** `false` ukrywa split-button "Zatwierdź jako zamiennik" (supersession dotyczy tylko `create`). */
  canSupersede?: boolean;
  /** Proposal sprzeczności (roadmap v1.6, B3): zamiana kierunku — po kliknięciu approve archiwizuje drugi wpis
   * pary. Brak propsa → przycisk się nie renderuje. Celowo BEZ skrótu klawiszowego (decyzja o wyborze
   * wersji ma być świadoma, nie odruchowa). */
  onSwapDirection?: () => void;
  /** Etykieta przycisku zamiany — nazywa wpis archiwizowany PO kliknięciu („Archiwizuj nowszy zamiast"). */
  swapLabel?: string;
}

/** §8.2 — sticky bar u dołu detalu: Zatwierdź(A)/Odrzuć(R)/Edytuj(E)/split-button "…jako
 * zamiennik"(S) / "Archiwizuj … zamiast" (tylko proposal sprzeczności, bez skrótu). Przy `stale` → primary disabled + inline alert z powodem. */
export function ProposalActions({
  onApprove,
  onReject,
  onEdit,
  onApproveAsReplacement,
  searchSupersedeCandidates,
  supersedeSuggestions,
  stale,
  staleReason,
  busy,
  position,
  canEdit = true,
  canSupersede = true,
  onSwapDirection,
  swapLabel = 'Zamień kierunek',
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
        {canEdit && (
          <Button variant="secondary" disabled={busy} onClick={onEdit}>
            <Pencil className="size-[15px]" /> Edytuj
            <kbd className="ml-0.5 rounded border border-current px-1 text-[10px] opacity-70">E</kbd>
          </Button>
        )}
        {onSwapDirection && (
          <Button variant="secondary" disabled={busy} onClick={onSwapDirection}>
            <ArrowLeftRight className="size-[15px]" /> {swapLabel}
          </Button>
        )}
        {canSupersede && (
          <SupersedeSplitButton
            onSelect={onApproveAsReplacement}
            search={searchSupersedeCandidates}
            suggested={supersedeSuggestions}
            disabled={busy}
          />
        )}
        {position && <span className="ml-auto font-mono text-[11px] text-faint">{position}</span>}
      </div>
    </div>
  );
}
