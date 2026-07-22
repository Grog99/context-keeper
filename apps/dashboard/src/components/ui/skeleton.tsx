import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/** §5 design-system.md: shimmer 1.2s liniowo, subtelny; respektuje `prefers-reduced-motion` (globals.css). */
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
