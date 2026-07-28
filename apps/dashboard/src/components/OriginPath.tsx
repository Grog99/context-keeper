import { Bot, Moon, User } from 'lucide-react';
import { cn } from '../lib/utils';
import type { MemoryScope, ProposalOrigin } from '../types/domain';

/** §2.4 design-systemu — mono, `text-xs`, `text-muted`; `nightly` dostaje tint `info` (inny profil
 * zaufania). Format: `źródło · scope[:projekt]`. */
export interface OriginPathProps {
  origin: ProposalOrigin;
  scope: MemoryScope;
  projectName?: string | null;
  className?: string;
}

const ICONS: Record<ProposalOrigin, typeof Bot> = { agent: Bot, human: User, nightly: Moon };

export function OriginPath({ origin, scope, projectName, className }: OriginPathProps) {
  const Icon = ICONS[origin];
  const scopeLabel = scope === 'global' ? 'global' : `project${projectName ? `:${projectName}` : ''}`;
  const isNightly = origin === 'nightly';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs text-muted-foreground',
        isNightly && 'text-info',
        className,
      )}
    >
      <Icon className="size-3" />
      {origin} · {scopeLabel}
    </span>
  );
}
