import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/** §8.2 — spokojny pusty stan, ikona line, bez clip-artu. Np. "Inbox zero — brak propozycji do przeglądu". */
export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center gap-2.5 px-10 py-10 text-center text-faint', className)}>
      <Icon className="size-8 text-border-strong" strokeWidth={1.5} />
      <div className="text-[15px] font-medium text-muted-foreground">{title}</div>
      {description && <div className="max-w-sm text-xs">{description}</div>}
      {action}
    </div>
  );
}
