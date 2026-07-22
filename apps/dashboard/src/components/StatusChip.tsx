import { Archive, CircleCheck, Clock, ShieldAlert, Lock, Trash2, X } from 'lucide-react';
import { Badge, type BadgeProps } from './ui/badge';
import { cn } from '../lib/utils';

/** Sygnatura §8.2 design-systemu — kolor + ikona + label RAZEM (P2, nigdy sam kolor). */
export type StatusChipStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'archived'
  | 'purged'
  | 'stale'
  | 'secret_blocked';

const CONFIG: Record<
  StatusChipStatus,
  { variant: NonNullable<BadgeProps['variant']>; icon: typeof Clock; label: string }
> = {
  pending: { variant: 'pending', icon: Clock, label: 'PENDING' },
  approved: { variant: 'success', icon: CircleCheck, label: 'APPROVED' },
  rejected: { variant: 'neutral', icon: X, label: 'REJECTED' },
  archived: { variant: 'neutral', icon: Archive, label: 'ARCHIVED' },
  // Ikona spójna z `AuditScreen.tsx` (purge_tombstone) — ten sam koncept, ten sam symbol.
  purged: { variant: 'danger', icon: Trash2, label: 'PURGED' },
  stale: { variant: 'danger', icon: Lock, label: 'STALE' },
  secret_blocked: { variant: 'danger', icon: ShieldAlert, label: 'SECRET_BLOCKED' },
};

export interface StatusChipProps {
  status: StatusChipStatus;
  className?: string;
}

export function StatusChip({ status, className }: StatusChipProps) {
  const { variant, icon: Icon, label } = CONFIG[status];
  return (
    <Badge variant={variant} className={cn('gap-1', className)}>
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}
