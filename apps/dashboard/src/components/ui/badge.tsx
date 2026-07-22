import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/** Bazowy Badge — `StatusChip` (§8.2, produktowy) rozszerza ten sam kształt wizualny (chip 22px,
 * uppercase, ikona+label). Warianty tutaj mapują 1:1 na paletę statusów §2.2. */
const badgeVariants = cva(
  'inline-flex h-[22px] items-center gap-1 rounded-sm border px-2 text-2xs font-semibold uppercase tracking-[0.04em] whitespace-nowrap',
  {
    variants: {
      variant: {
        // Bez modyfikatora opacity (`/30`) na tokenach CSS-variable — Tailwind nie potrafi wyliczyć
        // kanałów koloru dla `var(--x)` w czasie builda, więc pełna nieprzezroczystość obrysu
        // (uproszczenie względem `color-mix(...)` w makiecie, wciąż czytelne).
        pending: 'border-warning bg-warning-subtle text-warning-foreground',
        success: 'border-success bg-success-subtle text-success-foreground',
        danger: 'border-danger bg-danger-subtle text-danger-foreground',
        info: 'border-info bg-info-subtle text-info-foreground',
        neutral: 'border-border-strong bg-neutral-subtle text-neutral-foreground',
        kind: 'border-border-strong bg-background font-mono text-2xs font-medium normal-case tracking-normal text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
