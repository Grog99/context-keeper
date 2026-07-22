import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/** §8.2 — kafelek paska zdrowia: label `text-2xs` uppercase, wartość `text-lg` tabular-nums, kropka
 * statusu opcjonalna. Warianty z briefu (liczba/health-dot/wynik/licznik alertu) różnią się tylko
 * `status` + kształtem `value`, nie osobnymi komponentami. */
export type MetricStatStatus = 'ok' | 'warn' | 'bad' | 'neutral';

const DOT_CLASS: Record<MetricStatStatus, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger',
  neutral: 'bg-faint',
};

const TEXT_CLASS: Record<MetricStatStatus, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  neutral: 'text-foreground',
};

export interface MetricStatProps {
  label: string;
  value: ReactNode;
  status?: MetricStatStatus;
  className?: string;
}

export function MetricStat({ label, value, status, className }: MetricStatProps) {
  return (
    <div className={cn('flex flex-col justify-center gap-px border-l border-border px-3.5 first:border-l-0', className)}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-faint">{label}</span>
      <span
        className={cn(
          'flex items-center gap-1.5 font-mono text-lg font-semibold leading-tight tabular-nums',
          status ? TEXT_CLASS[status] : 'text-foreground',
        )}
      >
        {status && <span className={cn('size-[7px] shrink-0 rounded-full', DOT_CLASS[status])} />}
        {value}
      </span>
    </div>
  );
}
