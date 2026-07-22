import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../lib/utils';

/** §8.2 — `mem_…`/`ck_…`/`rev_…` w mono `text-xs`, klik = kopiuj (toast). Token zawsze maskowany
 * poza jednorazowym reveal (`TokenReveal` — ten komponent NIE odmaskowuje nic samodzielnie). */
export interface MonoIdProps {
  value: string;
  label?: string;
  className?: string;
}

export function MonoId({ value, label, className }: MonoIdProps) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      toast(`Skopiowano ${label ?? value}`);
    } catch {
      toast.error('Nie udało się skopiować do schowka');
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-mono text-xs text-faint',
        'transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      title="Kliknij, aby skopiować"
    >
      <Copy className="size-3" />
      {label ?? value}
    </button>
  );
}
