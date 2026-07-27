import { ArrowDownLeft, ArrowUpRight, ChevronDown, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { MemoryListItem, RelationListItemApi } from '../types/api';
import type { RelationType } from '../types/domain';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { StatusChip } from './StatusChip';

const RELATION_TYPES: RelationType[] = ['caused_by', 'follows', 'context_for'];

/** Debounce fetchu w `TargetPicker` (FINDING 8 review PR #15) — bez tego każdy keystroke odpalał
 * osobny request do `/memories`. */
const SEARCH_DEBOUNCE_MS = 300;

export interface RelationsPanelProps {
  /** Formularz dodawania widoczny WYŁĄCZNIE scope=project & status=approved (roadmap v1.2, plan
   * sekcja M) — mirror analogicznych guardów Edytuj/Promuj w MemoryBrowserScreen. `null`
   * `projectId` (scope=global) nigdy nie dociera tu z `canAdd=true`. */
  canAdd: boolean;
  projectId: string | null;
  relations: RelationListItemApi[];
  isLoading: boolean;
  creating: boolean;
  removingId: string | null;
  onCreate: (vars: { type: RelationType; targetId: string }) => void;
  onRemove: (relationId: string) => void;
  onSelectMemory: (id: string) => void;
  /** Id pamięci, której dotyczy panel (`detail.id` w `MemoryBrowserScreen`) — wyłącznie do
   * wykluczenia self-loop z TargetPicker (FINDING 8 review PR #15). To zawężenie UX z wyprzedzeniem,
   * NIE guard bezpieczeństwa: serwer i tak odrzuca self-loop jako `validation_error`
   * (`MemoryAdminService.createRelation`) niezależnie od tego, co pokazuje combobox. */
  currentMemoryId: string;
}

/**
 * Target picker (Popover+Command combobox, async search) — sam wzorzec co `SupersedeSplitButton`
 * w `ProposalActions.tsx` (`shouldFilter=false`, wyszukiwanie po stronie serwera). Zapytanie STRICT
 * `scope=project&projectId=` (nie `all`) — human dashboard i tak widzi wszystko, ale target relacji
 * musi być tego samego projektu co pamięć (§createRelation guard po stronie serwera; combobox tylko
 * zawęża wybór z wyprzedzeniem, serwer i tak jest autorytatywny).
 *
 * FINDING 8 review PR #15 — dwie poprawki ponad pierwotną wersję:
 *  1. Debounce (`SEARCH_DEBOUNCE_MS`) + strażnik sekwencji zapytań. `api.get` (`../lib/api.ts`)
 *     nie przyjmuje opcji (brak `signal`), więc zamiast `AbortController` używamy `requestSeqRef`:
 *     odpowiedź zwraca się, ale stosujemy ją tylko jeśli w międzyczasie nie poszło nowsze zapytanie
 *     (ignorujemy stale-response zamiast go anulować). `query` w polu aktualizuje się od razu —
 *     debounce dotyczy wyłącznie fetchu.
 *  2. `excludedIds` — self-loop (`currentMemoryId`) + targety z już istniejącą relacją są
 *     wykluczane z WYŚWIETLANEJ listy (patrz `RelationsPanel`, `excludedTargetIds`). To tylko
 *     UX-owe zawężenie wyboru z wyprzedzeniem: serwer i tak odrzuca self-loop/duplikat jako
 *     `validation_error` i to on jest autorytatywny — filtr niczego nie zabezpiecza, tylko nie
 *     proponuje oczywistego mis-clicku.
 */
function TargetPicker({
  projectId,
  excludedIds,
  onSelect,
  disabled,
}: {
  projectId: string | null;
  /** Id-y do wykluczenia z wyświetlanej listy — patrz komentarz p.2 wyżej. */
  excludedIds: ReadonlySet<string>;
  onSelect: (candidate: { id: string; header: string }) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryListItem[]>([]);
  const [loading, setLoading] = useState(false);

  const debounceTimerRef = useRef<number | undefined>(undefined);
  // Rośnie przy każdym nowym zapytaniu/resecie — odpowiedź porównuje swój numer z aktualnym i
  // ignoruje się, jeśli w międzyczasie poszło coś nowszego (stale-response clobber, FINDING 8).
  const requestSeqRef = useRef(0);

  // Timer po unmount komponentu (np. zamknięcie zakładki/pamięci w trakcie wpisywania) — sam fetch
  // ewentualnie doleci, ale strażnik sekwencji i tak by go zignorował; czyścimy dla porządku.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== undefined) window.clearTimeout(debounceTimerRef.current);
    };
  }, []);

  function resetSearch(): void {
    if (debounceTimerRef.current !== undefined) window.clearTimeout(debounceTimerRef.current);
    requestSeqRef.current += 1; // unieważnij ewentualny fetch w locie
    setQuery('');
    setResults([]);
    setLoading(false);
  }

  function runSearch(value: string): void {
    if (!projectId) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    api
      .get<MemoryListItem[]>(
        `/memories?scope=project&projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(value.trim())}`,
      )
      .then((found) => {
        if (requestSeqRef.current !== seq) return; // odpowiedź na nieaktualne zapytanie
        setResults(found.slice(0, 8));
        setLoading(false);
      })
      .catch(() => {
        if (requestSeqRef.current !== seq) return;
        setResults([]);
        setLoading(false);
      });
  }

  function handleQueryChange(value: string): void {
    setQuery(value); // natychmiast — debounce dotyczy tylko fetchu, nie pola input
    if (debounceTimerRef.current !== undefined) window.clearTimeout(debounceTimerRef.current);
    if (!projectId || value.trim().length === 0) {
      requestSeqRef.current += 1; // unieważnij ewentualny fetch w locie
      setResults([]);
      setLoading(false);
      return;
    }
    debounceTimerRef.current = window.setTimeout(() => runSearch(value), SEARCH_DEBOUNCE_MS);
  }

  const visibleResults = results.filter((candidate) => !excludedIds.has(candidate.id));
  // Serwer coś znalazł, ale wszystko odfiltrowane jako self/już-powiązane — inny komunikat niż
  // "brak wyników", żeby nie sugerować, że wyszukiwarka nic nie znalazła.
  const allFilteredOut = results.length > 0 && visibleResults.length === 0;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetSearch();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" disabled={disabled || !projectId} className="flex-1 justify-between">
          Wybierz pamięć…
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Szukaj pamięci w projekcie…" value={query} onValueChange={handleQueryChange} />
          <CommandList>
            <CommandEmpty>
              {loading ? 'Szukam…' : allFilteredOut ? 'Wszystko już połączone lub to ta sama pamięć.' : 'Brak wyników.'}
            </CommandEmpty>
            <CommandGroup>
              {visibleResults.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  onSelect={() => {
                    onSelect(candidate);
                    setOpen(false);
                    resetSearch();
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

function RelationRow({
  item,
  onSelectMemory,
  onRemove,
  removing,
}: {
  item: RelationListItemApi;
  onSelectMemory: (id: string) => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const outgoing = item.direction === 'outgoing';
  return (
    <li className="flex items-center gap-2 border-b border-border py-2 last:border-b-0">
      {outgoing ? (
        <ArrowUpRight className="size-3.5 shrink-0 text-faint" aria-label="wychodząca" />
      ) : (
        <ArrowDownLeft className="size-3.5 shrink-0 text-faint" aria-label="przychodząca" />
      )}
      <Badge variant="kind" className="shrink-0">
        {item.type}
      </Badge>
      <button
        type="button"
        onClick={() => onSelectMemory(item.neighbor.id)}
        className="min-w-0 flex-1 truncate text-left text-[13px] text-foreground underline decoration-dotted hover:decoration-solid"
      >
        {item.neighbor.header}
      </button>
      <Badge variant="kind" className="shrink-0">
        {item.neighbor.kind}
      </Badge>
      {item.neighbor.status !== 'approved' && <StatusChip status={item.neighbor.status} className="shrink-0" />}
      <Button
        variant="ghost-danger"
        size="sm"
        className="h-6 shrink-0 px-2"
        onClick={onRemove}
        disabled={removing}
        aria-label="Usuń relację"
      >
        <X className="size-3.5" />
      </Button>
    </li>
  );
}

/** Zakładka "Relacje" (roadmap v1.2, "memory-relations + 1-hop graph boost") — dwie sekcje
 * (wychodzące/przychodzące, jak zwraca `MemoryAdminService.listRelations`) + formularz dodawania.
 * Data-fetching/mutacje żyją w `MemoryBrowserScreen` (jak `revisions`/`detail`) — ten komponent jest
 * czysto prezentacyjny + samodzielny WYŁĄCZNIE dla async wyszukiwania targetu (`TargetPicker`,
 * mirror `SupersedeSplitButton`). */
export function RelationsPanel({
  canAdd,
  projectId,
  relations,
  isLoading,
  creating,
  removingId,
  onCreate,
  onRemove,
  onSelectMemory,
  currentMemoryId,
}: RelationsPanelProps) {
  const [type, setType] = useState<RelationType>('caused_by');
  const outgoing = relations.filter((r) => r.direction === 'outgoing');
  const incoming = relations.filter((r) => r.direction === 'incoming');
  // Wykluczone z TargetPicker (FINDING 8 review PR #15): targety, z którymi relacja już istnieje
  // (niezależnie od kierunku) + bieżąca pamięć sama (self-loop). Tylko UX-owe zawężenie wyboru z
  // wyprzedzeniem — serwer i tak odrzuca oba przypadki jako `validation_error`.
  const excludedTargetIds = new Set([...relations.map((r) => r.neighbor.id), currentMemoryId]);

  return (
    <div className="flex flex-col gap-4">
      {canAdd && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5">
          <Select value={type} onValueChange={(v) => setType(v as RelationType)}>
            <SelectTrigger className="h-8 w-36 shrink-0 gap-1.5 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RELATION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <TargetPicker
            projectId={projectId}
            excludedIds={excludedTargetIds}
            disabled={creating}
            onSelect={(candidate) => onCreate({ type, targetId: candidate.id })}
          />
        </div>
      )}

      {isLoading ? (
        <p className="text-xs text-faint">Ładowanie…</p>
      ) : relations.length === 0 ? (
        <p className="text-xs text-faint">Brak relacji.</p>
      ) : (
        <>
          {outgoing.length > 0 && (
            <div>
              <h3 className="mb-1 text-2xs font-semibold uppercase tracking-[0.04em] text-faint">Wychodzące</h3>
              <ul className="m-0 list-none p-0">
                {outgoing.map((r) => (
                  <RelationRow
                    key={r.id}
                    item={r}
                    onSelectMemory={onSelectMemory}
                    onRemove={() => onRemove(r.id)}
                    removing={removingId === r.id}
                  />
                ))}
              </ul>
            </div>
          )}
          {incoming.length > 0 && (
            <div>
              <h3 className="mb-1 text-2xs font-semibold uppercase tracking-[0.04em] text-faint">Przychodzące</h3>
              <ul className="m-0 list-none p-0">
                {incoming.map((r) => (
                  <RelationRow
                    key={r.id}
                    item={r}
                    onSelectMemory={onSelectMemory}
                    onRemove={() => onRemove(r.id)}
                    removing={removingId === r.id}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
