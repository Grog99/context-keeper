import { Undo2 } from 'lucide-react';
import { AUTO_HOLD_REASON_LABEL } from '../lib/proposals';
import type { AutoHoldReason } from '../types/domain';

/** §8.2 — powód(y) zawrócenia zapisu z auto mode do kolejki (roadmap v1.6, A2, G5). `attention` alert
 * inline nad `DedupHint` w detalu propozycji; `null` gdy nic nie zawrócono (projekt bez auto mode,
 * zapisy sprzed A2) — wtedy brak bloku. Informacyjny: nie blokuje decyzji recenzenta. */
export interface AutoHoldNoticeProps {
  reasons: AutoHoldReason[] | null | undefined;
}

export function AutoHoldNotice({ reasons }: AutoHoldNoticeProps) {
  if (!reasons || reasons.length === 0) return null;

  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-md border border-warning bg-warning-subtle px-3 py-2.5 text-xs text-warning-foreground">
      <Undo2 className="mt-0.5 size-[15px] shrink-0 text-warning" />
      <div>
        <p className="font-medium">Zawrócone z auto mode — wymaga decyzji człowieka:</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {reasons.map((reason) => (
            <li key={reason}>{AUTO_HOLD_REASON_LABEL[reason]}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
