import type { BulkDecisionItemError } from '../types/api';
import { MonoId } from './MonoId';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

export interface BulkFailuresDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  failures: BulkDecisionItemError[];
}

/**
 * Szczegóły porażek bulk approve/reject (roadmap v1.3, "Bulk approve/reject w kolejce") — otwierany
 * akcją „Szczegóły" na toaście podsumowującym (`QueueScreen.reportBulk`). Konkretne id + kod +
 * komunikat serwera, żeby porażki częściowego sukcesu nie znikały niezauważone za samym zbiorczym
 * licznikiem toasta — recenzent widzi DOKŁADNIE, które propozycje zostały (nadal zaznaczone,
 * `reportBulk` ich nie odznacza) i dlaczego.
 */
export function BulkFailuresDialog({ open, onOpenChange, failures }: BulkFailuresDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nieudane decyzje ({failures.length})</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Te propozycje NIE zostały zatwierdzone/odrzucone i zostają zaznaczone — popraw przyczynę
          (np. odśwież po zmianie stale) i spróbuj ponownie.
        </DialogDescription>
        <ul className="m-0 flex max-h-80 list-none flex-col gap-2 overflow-y-auto p-0">
          {failures.map((f) => (
            <li key={f.id} className="flex flex-col gap-1 rounded-md border border-border bg-muted px-3 py-2">
              <div className="flex items-center gap-2">
                <MonoId value={f.id} />
                <span className="rounded-sm border border-danger bg-danger-subtle px-1.5 py-px font-mono text-2xs uppercase tracking-[0.04em] text-danger-foreground">
                  {f.code}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">{f.message}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
