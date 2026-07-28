import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { cn } from '../../lib/utils';

/** shadcn/radix (§8.1 design-system.md — bazowe komponenty, przetematyzowane tokenami). Nowy
 * prymityw (roadmap v1.3, "Bulk approve/reject w kolejce") — checkbox per-wiersz w `ProposalRow` +
 * „zaznacz wszystkie" w pasku filtrów `QueueScreen`. Radix (nie natywny `<input type="checkbox">`),
 * bo `indeterminate` („zaznacz wszystkie" gdy zaznaczona jest tylko CZĘŚĆ widocznej listy) jest tu
 * deklaratywny (`checked="indeterminate"`) — natywny input wymaga imperatywnego zapisu przez ref.
 * Checked/indeterminate = `bg-primary` (iris, jak `Switch`); focus ring jak reszta interaktywnych
 * (§10 — focus-visible zawsze widoczny). */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer size-4 shrink-0 rounded-[4px] border border-border-strong bg-background',
      'transition-colors duration-150 ease-out',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-45',
      'data-[state=checked]:border-primary data-[state=checked]:bg-primary',
      'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-primary-foreground">
      {props.checked === 'indeterminate' ? <Minus className="size-3" /> : <Check className="size-3" />}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
