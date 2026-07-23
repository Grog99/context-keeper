import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '../../lib/utils';

/** shadcn/radix (§8.1 design-system.md — bazowe komponenty, przetematyzowane tokenami). Nowy
 * prymityw (roadmap v1.2, "kind=event episodic") — `ProjectSettingsDialog` "Dołączaj zdarzenia do
 * domyślnego wyszukiwania". Checked = `bg-primary` (iris, jak primary button); focus ring jak reszta
 * interaktywnych (§10 — focus-visible zawsze widoczny). */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-[22px] w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent',
      'transition-colors duration-150 ease-out',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-45',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-border-strong',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block size-[18px] rounded-full bg-white shadow-sm ring-0 transition-transform duration-150 ease-out',
        'data-[state=checked]:translate-x-[17px] data-[state=unchecked]:translate-x-[2px]',
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
