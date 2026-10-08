import type { ReactNode } from 'react';
import { AUTO_HOLD_REASON_SHORT_LABEL, percentShares } from '../lib/proposals';
import type { AutoModeFateCounts, AutoModeProjectMetrics } from '../types/api';
import type { AutoHoldReason } from '../types/domain';
import { Badge } from './ui/badge';

const HOLD_REASONS = Object.keys(AUTO_HOLD_REASON_SHORT_LABEL) as AutoHoldReason[];

const COLUMNS = ['Projekt', 'Typ', 'Auto', 'Przycięte', 'Nadpisane', 'Zarchiwizowane', 'Cofnięte', 'Nietknięte', 'Zawrócone'];

/** Kolejność kubełków = kolejność kolumn; `percentShares` zwraca całkowite procenty sumujące się do 100. */
function bucketCounts(c: AutoModeFateCounts): number[] {
  return [c.pruned, c.overwritten, c.archived, c.undone, c.untouched];
}

function BucketCells({ counts }: { counts: AutoModeFateCounts }) {
  const shares = percentShares(bucketCounts(counts));
  const values = bucketCounts(counts);
  return (
    <>
      {values.map((count, i) => (
        <td key={i} className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
          {counts.total === 0 ? (
            <span className="text-faint">—</span>
          ) : (
            <>
              <span className="text-foreground">{shares[i]}%</span>
              <span className="ml-1.5 font-mono text-xs text-faint">{count}</span>
            </>
          )}
        </td>
      ))}
    </>
  );
}

function FateRow({
  label,
  counts,
  lead,
  trail,
  groupStart = false,
}: {
  label: string;
  counts: AutoModeFateCounts;
  lead?: ReactNode;
  trail?: ReactNode;
  /** Pierwszy z dwóch wierszy projektu — bez dolnej kreski (kreska tylko między projektami). */
  groupStart?: boolean;
}) {
  return (
    <tr className={groupStart ? undefined : 'border-b border-border last:border-b-0'}>
      {lead}
      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{label}</td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-foreground">{counts.total}</td>
      <BucketCells counts={counts} />
      {trail}
    </tr>
  );
}

/**
 * Tabela „Auto mode" na ekranie Pomiary (roadmap v1.6, A4) — wiersz projektu to dwa wiersze: `create` (utworzenia)
 * i `update` (korekty), bo korekta agenta to inny sygnał niż nowy wpis. Kubełki (przycięte / nadpisane /
 * zarchiwizowane / cofnięte / nietknięte) są rozłączne i sumują się do 100% (`percentShares`). „Zawrócone" to
 * zapisy skierowane przez bezpiecznik do kolejki, z podziałem na powody (propozycja z dwoma powodami wchodzi do obu).
 */
export function AutoModeMetricsTable({ projects }: { projects: AutoModeProjectMetrics[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {COLUMNS.map((c, i) => (
                <th
                  key={c}
                  scope="col"
                  className={`px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint ${
                    i >= 2 && i <= 7 ? 'text-right' : 'text-left'
                  }`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <ProjectRows key={p.projectId} project={p} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProjectRows({ project: p }: { project: AutoModeProjectMetrics }) {
  const heldReasons = HOLD_REASONS.filter((r) => p.held.reasons[r] > 0);
  return (
    <>
      <FateRow
        label="utworzenia"
        counts={p.create}
        groupStart
        lead={
          <th scope="row" rowSpan={2} className="border-r border-border px-3 py-2 text-left align-top font-medium">
            <div className="flex items-center gap-2">
              <span className="max-w-[180px] truncate text-foreground" title={p.projectName}>
                {p.projectName}
              </span>
              {p.autoModeEnabled ? (
                <Badge variant="info">auto</Badge>
              ) : (
                <span className="text-xs font-normal text-faint" title="Auto mode jest dziś wyłączony — wiersz pokazuje historię z zakresu">
                  wyłączony
                </span>
              )}
            </div>
          </th>
        }
        trail={
          <td rowSpan={2} className="border-l border-border px-3 py-2 align-top text-xs">
            {p.held.total === 0 ? (
              <span className="text-faint">—</span>
            ) : (
              <>
                <div className="font-mono text-sm tabular-nums text-foreground">{p.held.total}</div>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {heldReasons.map((r) => (
                    <li key={r} className="whitespace-nowrap">
                      {AUTO_HOLD_REASON_SHORT_LABEL[r]} · <span className="font-mono tabular-nums">{p.held.reasons[r]}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </td>
        }
      />
      <FateRow label="korekty" counts={p.update} />
    </>
  );
}
