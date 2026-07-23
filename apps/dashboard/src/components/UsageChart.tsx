import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AXIS_LINE, AXIS_TICK, LEGEND_STYLE, TOOLTIP_STYLE, assignProjectColors, formatBucketLabel } from '../lib/usage-chart';
import type { ProjectSearchSeries, ProposalOutcomeBucketPoint, UsageBucket } from '../types/api';

export interface SearchVolumeChartProps {
  series: ProjectSearchSeries[];
  bucket: UsageBucket;
}

/** Panel (a) — wolumen `search_memory` w czasie, jedna warstwa (area, stacked) per projekt. */
export function SearchVolumeChart({ series, bucket }: SearchVolumeChartProps) {
  const colors = assignProjectColors(series.map((s) => s.projectId));
  const byTs = new Map<string, Record<string, number | string>>();
  for (const project of series) {
    for (const b of project.buckets) {
      let row = byTs.get(b.ts);
      if (!row) {
        row = { ts: b.ts };
        byTs.set(b.ts, row);
      }
      row[project.projectId] = b.searches;
    }
  }
  const data = Array.from(byTs.values()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="ts"
          tickFormatter={(ts: string) => formatBucketLabel(ts, bucket)}
          tick={AXIS_TICK}
          axisLine={AXIS_LINE}
          tickLine={AXIS_LINE}
        />
        <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={32} />
        <Tooltip
          labelFormatter={(label) => formatBucketLabel(String(label), bucket)}
          formatter={(value, name) => [value, series.find((s) => s.projectId === name)?.projectName ?? String(name)]}
          contentStyle={TOOLTIP_STYLE}
        />
        <Legend
          wrapperStyle={LEGEND_STYLE}
          formatter={(value) => series.find((s) => s.projectId === value)?.projectName ?? value}
        />
        {series.map((project) => (
          <Area
            key={project.projectId}
            type="monotone"
            dataKey={project.projectId}
            name={project.projectId}
            stackId="searches"
            stroke={colors.get(project.projectId)}
            fill={colors.get(project.projectId)}
            fillOpacity={0.35}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface ZeroResultTrendChartProps {
  series: ProjectSearchSeries[];
  bucket: UsageBucket;
}

/** Panel (b), trend — zero-result rate PER BUCKET per projekt (`degraded` już wyłączone przez
 * serwer z liczników `zeroResult`/`searches` — patrz `usage.service.ts` §5(i)). Bucket bez wyszukiwań
 * = `null` (gap w linii), nie 0% — "brak danych" to co innego niż "same trafienia". */
export function ZeroResultTrendChart({ series, bucket }: ZeroResultTrendChartProps) {
  const colors = assignProjectColors(series.map((s) => s.projectId));
  const byTs = new Map<string, Record<string, number | string | null>>();
  for (const project of series) {
    for (const b of project.buckets) {
      let row = byTs.get(b.ts);
      if (!row) {
        row = { ts: b.ts };
        byTs.set(b.ts, row);
      }
      row[project.projectId] = b.searches === 0 ? null : Math.round((b.zeroResult / b.searches) * 1000) / 10;
    }
  }
  const data = Array.from(byTs.values()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="ts"
          tickFormatter={(ts: string) => formatBucketLabel(ts, bucket)}
          tick={AXIS_TICK}
          axisLine={AXIS_LINE}
          tickLine={AXIS_LINE}
        />
        <YAxis
          unit="%"
          domain={[0, 100]}
          tick={AXIS_TICK}
          axisLine={AXIS_LINE}
          tickLine={AXIS_LINE}
          width={40}
        />
        <Tooltip
          labelFormatter={(label) => formatBucketLabel(String(label), bucket)}
          formatter={(value, name) => [
            `${value}%`,
            series.find((s) => s.projectId === name)?.projectName ?? String(name),
          ]}
          contentStyle={TOOLTIP_STYLE}
        />
        <Legend
          wrapperStyle={LEGEND_STYLE}
          formatter={(value: string) => series.find((s) => s.projectId === value)?.projectName ?? value}
        />
        {series.map((project) => (
          <Line
            key={project.projectId}
            type="monotone"
            dataKey={project.projectId}
            name={project.projectId}
            stroke={colors.get(project.projectId)}
            dot={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export interface ProposalOutcomeChartProps {
  buckets: ProposalOutcomeBucketPoint[];
  bucket: UsageBucket;
}

/** Panel (c) — decyzje recenzenta w czasie. `approved` rozbite na dwa stackowane segmenty
 * (bez edycji / z edycją), żeby "edit ⊆ accepted" (§5(f)) było widoczne WPROST w wykresie, nie
 * tylko w opisie — trzeci segment to `rejected`, osobna kategoria. */
export function ProposalOutcomeChart({ buckets, bucket }: ProposalOutcomeChartProps) {
  const data = buckets.map((b) => ({
    ts: b.ts,
    approvedNoEdits: b.approved - b.approvedWithEdits,
    approvedWithEdits: b.approvedWithEdits,
    rejected: b.rejected,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="ts"
          tickFormatter={(ts: string) => formatBucketLabel(ts, bucket)}
          tick={AXIS_TICK}
          axisLine={AXIS_LINE}
          tickLine={AXIS_LINE}
        />
        <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={32} />
        <Tooltip labelFormatter={(label) => formatBucketLabel(String(label), bucket)} contentStyle={TOOLTIP_STYLE} />
        <Legend
          wrapperStyle={LEGEND_STYLE}
          formatter={(value: string) =>
            ({ approvedNoEdits: 'Zaakceptowane', approvedWithEdits: 'Zaakceptowane z edycją', rejected: 'Odrzucone' })[
              value
            ] ?? value
          }
        />
        <Bar dataKey="approvedNoEdits" name="approvedNoEdits" stackId="outcome" fill="var(--success)" />
        <Bar dataKey="approvedWithEdits" name="approvedWithEdits" stackId="outcome" fill="var(--info)" />
        <Bar dataKey="rejected" name="rejected" stackId="outcome" fill="var(--danger)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
