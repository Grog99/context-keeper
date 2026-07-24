import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useActiveContext } from '../lib/context';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export interface ContextSwitcherProjectOption {
  id: string;
  name: string;
}

/** §8.2/§9.6 — top bar: `Wszystkie` / `Global` / `‹projekty…›` (Command-search). Aktywny kontekst
 * dziedziczy cała aplikacja przez `useActiveContext` (FR-D6). Lista projektów przychodzi z zewnątrz
 * (dane, nie ten komponent, robią fetch — §M4 wpina realny `GET /api/projects`). */
export interface ContextSwitcherProps {
  projects: ContextSwitcherProjectOption[];
}

export function ContextSwitcher({ projects }: ContextSwitcherProps) {
  const { active, setActive } = useActiveContext();
  const [open, setOpen] = useState(false);

  const label = active.kind === 'all' ? 'Wszystkie' : active.kind === 'global' ? 'global' : active.projectName;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-md border border-border-strong bg-background px-2.5 text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="size-[7px] shrink-0 rounded-full bg-primary" />
          <span className="max-w-[160px] truncate">{label}</span>
          <ChevronDown className="size-[15px] shrink-0 text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Szukaj projektu…" />
          <CommandList>
            <CommandEmpty>Brak wyników.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setActive({ kind: 'all' });
                  setOpen(false);
                }}
              >
                Wszystkie
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setActive({ kind: 'global' });
                  setOpen(false);
                }}
              >
                Global
              </CommandItem>
            </CommandGroup>
            {projects.length > 0 && (
              <CommandGroup heading="Projekty">
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={project.name}
                    onSelect={() => {
                      setActive({ kind: 'project', projectId: project.id, projectName: project.name });
                      setOpen(false);
                    }}
                  >
                    {project.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
