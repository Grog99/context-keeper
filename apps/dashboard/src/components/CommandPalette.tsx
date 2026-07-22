import { Archive, FolderKanban, Inbox, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { MemoryListItem } from '../types/api';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Dialog, DialogContent } from './ui/dialog';

interface ScreenEntry {
  to: string;
  label: string;
  icon: typeof Inbox;
}

const SCREENS: ScreenEntry[] = [
  { to: '/kolejka', label: 'Kolejka', icon: Inbox },
  { to: '/pamiec', label: 'Pamięć', icon: Archive },
  { to: '/projekty', label: 'Projekty', icon: FolderKanban },
  { to: '/audyt', label: 'Audyt', icon: ScrollText },
];

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** ⌘K (§8.1/§9.0/§10 design-systemu) — nawigacja do ekranów + wyszukiwanie pamięci na żywo
 * (`GET /api/memories?q=`). `Command` bezpośrednio (nie `CommandDialog`) z `shouldFilter=false` —
 * jak `ProposalActions`' `SupersedeSplitButton` (§M3): filtrowanie po stronie serwera/tego
 * komponentu, nie lokalny fuzzy-match cmdk nad asynchroniczną listą. */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryListItem[]>([]);
  const [loading, setLoading] = useState(false);

  async function handleQueryChange(value: string): Promise<void> {
    setQuery(value);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const found = await api.get<MemoryListItem[]>(`/memories?q=${encodeURIComponent(value.trim())}`);
      setResults(found.slice(0, 8));
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function go(to: string): void {
    onOpenChange(false);
    setQuery('');
    setResults([]);
    navigate(to);
  }

  const matchingScreens = query.trim()
    ? SCREENS.filter((s) => s.label.toLowerCase().includes(query.trim().toLowerCase()))
    : SCREENS;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden p-0 shadow-md">
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.04em] [&_[cmdk-group-heading]]:text-faint"
        >
          <CommandInput
            placeholder="Szukaj pamięci albo skocz do ekranu…"
            value={query}
            onValueChange={handleQueryChange}
          />
          <CommandList>
            <CommandEmpty>{loading ? 'Szukam…' : 'Brak wyników.'}</CommandEmpty>
            {matchingScreens.length > 0 && (
              <CommandGroup heading="Ekrany">
                {matchingScreens.map((screen) => (
                  <CommandItem key={screen.to} value={screen.to} onSelect={() => go(screen.to)}>
                    <screen.icon className="size-4 text-faint" />
                    {screen.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.length > 0 && (
              <CommandGroup heading="Pamięć">
                {results.map((item) => (
                  <CommandItem key={item.id} value={item.id} onSelect={() => go(`/pamiec?id=${item.id}`)}>
                    <span className="min-w-0 flex-1 truncate">{item.header}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-faint">{item.id}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
