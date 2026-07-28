import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

const GLOBAL_SHORTCUTS: [string, string][] = [
  ['⌘K / Ctrl K', 'Paleta poleceń / szukaj'],
  ['/', 'To samo co ⌘K'],
  ['g k', 'Idź do: Kolejka'],
  ['g p', 'Idź do: Pamięć'],
  ['g c', 'Idź do: Oś czasu'],
  ['g t', 'Idź do: Projekty'],
  ['g a', 'Idź do: Audyt'],
  ['g m', 'Idź do: Pomiary'],
  ['g o', 'Idź do: Operacje'],
  ['g w', 'Idź do: Onboarding'],
  ['?', 'Ta ściągawka'],
];

const QUEUE_SHORTCUTS: [string, string][] = [
  ['j / k', 'Następna / poprzednia propozycja'],
  ['Enter', 'Otwórz szczegóły'],
  ['A', 'Zatwierdź'],
  ['R', 'Odrzuć'],
  ['E', 'Edytuj'],
  ['S', 'Zatwierdź jako zamiennik'],
  ['x', 'Zaznacz / odznacz propozycję'],
];

export interface KeyboardCheatsheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** §10 design-systemu — "Skróty widoczne w tooltipach i „?" cheatsheet." */
export function KeyboardCheatsheet({ open, onOpenChange }: KeyboardCheatsheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Skróty klawiaturowe</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">Lista skrótów klawiaturowych dashboardu.</DialogDescription>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <ShortcutGroup title="Globalne" items={GLOBAL_SHORTCUTS} />
          <ShortcutGroup title="Kolejka" items={QUEUE_SHORTCUTS} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutGroup({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.05em] text-faint">{title}</h3>
      {items.map(([key, label]) => (
        <div key={key} className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{label}</span>
          <kbd className="whitespace-nowrap rounded border border-border-strong bg-muted px-1.5 py-0.5 font-mono text-2xs text-foreground">
            {key}
          </kbd>
        </div>
      ))}
    </div>
  );
}
