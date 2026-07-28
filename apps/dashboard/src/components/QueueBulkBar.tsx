import { Check, X } from 'lucide-react';
import { pluralProposals } from '../lib/format';
import { Button } from './ui/button';

export interface QueueBulkBarProps {
  count: number;
  /** Ile z zaznaczonych jest `stale` — informacyjnie tutaj, pełne ostrzeżenie („zatwierdzenie im
   * się nie powiedzie") żyje w `AlertDialog` potwierdzającym bulk approve (`QueueScreen`). */
  staleCount: number;
  onApprove: () => void;
  onReject: () => void;
  onClear: () => void;
  busy?: boolean;
}

/**
 * Pasek zbiorczej decyzji (roadmap v1.3, "Bulk approve/reject w kolejce") — renderowany w lewej
 * kolumnie (lista propozycji) POD paskiem filtrów, WYŁĄCZNIE gdy `count > 0` (`QueueScreen`).
 * Świadomie BEZ „Zatwierdź jako zamiennik" (supersede zostaje jednoelementowy, §1.1 planu) i BEZ
 * paska postępu (poza zakresem — `busy` wyłącznie disable'uje przyciski na czas requestu).
 */
export function QueueBulkBar({ count, staleCount, onApprove, onReject, onClear, busy }: QueueBulkBarProps) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-border-strong bg-accent-subtle px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-foreground">
          Zaznaczono {count} {pluralProposals(count)}
          {staleCount > 0 && (
            <span className="text-danger"> ({staleCount} stale)</span>
          )}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-[11px]" onClick={onClear} disabled={busy}>
          Anuluj zaznaczenie
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={onApprove} disabled={busy}>
          <Check className="size-3.5" /> Zatwierdź ({count})
        </Button>
        <Button variant="ghost-danger" size="sm" onClick={onReject} disabled={busy}>
          <X className="size-3.5" /> Odrzuć ({count})
        </Button>
      </div>
    </div>
  );
}
