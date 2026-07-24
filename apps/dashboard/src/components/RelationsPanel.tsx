import { ArrowDownLeft, ArrowUpRight, ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
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
}

/**
 * Target picker (Popover+Command combobox, async search) — sam wzorzec co `SupersedeSplitButton`
 * w `ProposalActions.tsx` (`shouldFilter=false`, wyszukiwanie po stronie serwera). Zapytanie STRICT
 * `scope=project&projectId=` (nie `all`) — human dashboard i tak widzi wszystko, ale target relacji
 * musi być tego samego projektu co pamięć (§createRelation guard po stronie serwera; combobox tylko
 * zawęża wybór z wyprzedzeniem, serwer i tak jest autorytatywny).
 */
function TargetPicker({
  projectId,
  onSelect,
  disabled,
}: {
  projectId: string | null;
  onSelect: (candidate: { id: string; header: string }) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryListItem[]>([]);
  const [loading, setLoading] = useState(false);

  async function handleQueryChange(value: string): Promise<void> {
    setQuery(value);
    if (!projectId || value.trim().length === 0) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const found = await api.get<MemoryListItem[]>(
        `/memories?scope=project&projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(value.trim())}`,
      );
      setResults(found.slice(0, 8));
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery('');
          setResults([]);
        }
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
            <CommandEmpty>{loading ? 'Szukam…' : 'Brak wyników.'}</CommandEmpty>
            <CommandGroup>
              {results.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  onSelect={() => {
                    onSelect(candidate);
                    setOpen(false);
                    setQuery('');
                    setResults([]);
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
}: RelationsPanelProps) {
  const [type, setType] = useState<RelationType>('caused_by');
  const outgoing = relations.filter((r) => r.direction === 'outgoing');
  const incoming = relations.filter((r) => r.direction === 'incoming');

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
