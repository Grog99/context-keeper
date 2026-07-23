import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/** Ekran "Onboarding" (roadmap v1.2) — blok kod + przycisk Copy, DRY nad wzorcem
 * `TokenReveal.handleCopy` (§8.2: `navigator.clipboard.writeText` + toast `sonner`). Trzy snippety
 * (AGENTS.md, `.mcp.json`, notatka CLAUDE.md) współdzielą ten komponent zamiast powtarzać go inline. */
export interface CopyBlockProps {
  /** Etykieta nad blokiem (np. nazwa pliku docelowego) — Polish UI chrome. */
  label: string;
  /** Treść bloku — WIERNIE to, co ląduje w schowku (żadnej transformacji przy renderze). */
  code: string;
  /** aria-label przycisku Copy — identyfikuje KTÓRY blok kopiujemy (a11y, kilka bloków na ekranie). */
  copyLabel: string;
  className?: string;
}

export function CopyBlock({ label, code, copyLabel, className }: CopyBlockProps) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      toast('Skopiowano');
    } catch {
      toast.error('Nie udało się skopiować do schowka');
    }
  }

  return (
    <div className={cn('overflow-hidden rounded-md border border-border', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button variant="secondary" size="sm" className="h-6 px-2" onClick={handleCopy} aria-label={copyLabel}>
          <Copy className="size-3.5" />
          Kopiuj
        </Button>
      </div>
      <pre className="overflow-x-auto bg-muted px-3 py-2.5 font-mono text-[13px] leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}
