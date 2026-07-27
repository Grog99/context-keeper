import { Ban, CircleCheck, Clock, ShieldOff } from 'lucide-react';
import { Badge } from './ui/badge';
import type { EffectiveTokenStatus } from '../types/domain';

const CONFIG: Record<EffectiveTokenStatus, { icon: typeof CircleCheck; variant: 'success' | 'pending' | 'neutral' | 'danger'; label: string }> = {
  active: { icon: CircleCheck, variant: 'success', label: 'aktywny' },
  grace: { icon: Clock, variant: 'pending', label: 'karencja' },
  expired: { icon: Ban, variant: 'neutral', label: 'wygasły' },
  revoked: { icon: ShieldOff, variant: 'danger', label: 'unieważniony' },
};

/** §8.2 design-systemu, roadmap v1.3 ("Wiele tokenów per projekt + graceful rotation") — badge
 * `effectiveStatus` tokena (`ProjectTokenApi.effectiveStatus`, liczone server-side przez
 * `effectiveTokenStatus`, SPA nigdy nie liczy tego samodzielnie). Ikona + kolor + label razem (P2). */
export function TokenStatusBadge({ status }: { status: EffectiveTokenStatus }) {
  const { icon: Icon, variant, label } = CONFIG[status];
  return (
    <Badge variant={variant} className="normal-case tracking-normal">
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}
