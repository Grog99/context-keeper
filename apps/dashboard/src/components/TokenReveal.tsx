import { Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

/** §8.2 — Dialog jednorazowego pokazania `ck_…`. Po zamknięciu nieodwracalnie zamaskowany: rodzic
 * NIE przechowuje `token` po `onOpenChange(false)` (jednorazowy prop, nie stan lokalny appki). */
export interface TokenRevealProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  /** "utworzony" (nowy projekt) vs "rotowany" (hard-cutover) — różni się tylko copy ostrzeżenia. */
  reason?: 'created' | 'rotated';
}

export function TokenReveal({ open, onOpenChange, token, reason = 'created' }: TokenRevealProps) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token);
      toast('Token skopiowany');
    } catch {
      toast.error('Nie udało się skopiować do schowka');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <KeyRound className="size-[19px] text-primary" />
          <DialogTitle>{reason === 'rotated' ? 'Token zrotowany' : 'Nowy token projektu'}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Skopiuj teraz — pokazujemy go tylko raz. W bazie trzymamy wyłącznie <span className="font-mono">SHA-256</span>{' '}
          hash.
        </DialogDescription>
        <div className="mb-3 flex items-center gap-2.5 rounded-md border border-border bg-muted px-3.5 py-3">
          <code className="flex-1 break-all font-mono text-[13.5px] text-foreground">{token}</code>
          <Button variant="secondary" size="sm" onClick={handleCopy} aria-label="Kopiuj token">
            <Copy className="size-4" />
          </Button>
        </div>
        <div className="mb-4 flex items-start gap-2 rounded-md border border-warning bg-warning-subtle px-2.5 py-2 text-xs text-warning-foreground">
          <ShieldAlert className="mt-0.5 size-[15px] shrink-0 text-warning" />
          {reason === 'rotated'
            ? 'Rotacja to hard-cutover — stary token przestaje działać natychmiast. Zaktualizuj konfigurację klientów MCP.'
            : 'Zapisz token w bezpiecznym miejscu — nie da się go odzyskać po zamknięciu tego okna.'}
        </div>
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Zapisałem token
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
