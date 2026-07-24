import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

type ContainerWidth = 'prose' | 'list' | 'wide' | 'chart';

const WIDTH_CLASS: Record<ContainerWidth, string> = {
  prose: 'max-w-3xl',
  list: 'max-w-4xl',
  wide: 'max-w-5xl',
  chart: 'max-w-6xl',
};

/** Centered, width-capped column for "document" screens. The scroll container is <main> in AppShell;
 * this owns only padding + centering + a per-screen readable max-width. */
export function ScreenContainer({
  width = 'wide',
  className,
  children,
}: {
  width?: ContainerWidth;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="p-6">
      <div className={cn('mx-auto w-full', WIDTH_CLASS[width], className)}>{children}</div>
    </div>
  );
}
