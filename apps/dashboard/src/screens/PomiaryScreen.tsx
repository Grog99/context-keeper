import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { MetricStat } from '../components/MetricStat';
import { ProposalOutcomeChart, SearchVolumeChart, ZeroResultTrendChart } from '../components/UsageChart';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query';
import { toQueryString } from '../lib/query-string';
import type { ProjectListItem, UsageBucket, UsageMetrics } from '../types/api';

type RangeDays = 7 | 30;

const DAY_MS = 24 * 60 * 60_000;

/** Próg severity dla badge zero-result rate — heurystyka UI (nie kontrakt serwera): poniżej 10% =
 * spokojnie (success), 10-30% = warto zerknąć (pending/warning), powyżej = pamięć realnie nie ma
 * czym odpowiadać na zapytania tego projektu (danger). */
function rateSeverity(rate: number): 'success' | 'pending' | 'danger' {
  if (rate < 0.1) return 'success';
  if (rate < 0.3) return 'pending';
  return 'danger';
}

function formatPct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

/**
 * Ekran "Pomiary" (roadmap v1.1) — odpowiada na: ile `search_memory` per projekt w czasie, jaki
 * odsetek nie zwraca wyników (headline sygnał §5(i), `degraded` wyłączone z sygnału — provider
 * embeddingów down/timeout to NIE "pamięć pusta"), oraz jak recenzent decyduje w kolejce
 * (accept/reject/edit, gdzie "edit" = zaakceptowane-z-edycją, PODZBIÓR zaakceptowanych, §5(f)).
 * Zasilany `GET /api/metrics/usage` (`usage-metrics.controller.ts`), osobny od snapshotu
 * `MetricsController`/paska zdrowia AppShell.
 */
export function PomiaryScreen() {
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [bucket, setBucket] = useState<UsageBucket>('day');
  const [projectId, setProjectId] = useState<string>('all');

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectListItem[]>('/projects'),
  });

  const filterParams: Record<string, string> = { bucket };
  if (projectId !== 'all') filterParams.projectId = projectId;

  const { data, isLoading } = useQuery({
    // `rangeDays` dokłada się do klucza (inwaliduje cache przy zmianie presetu), mimo że serwer
    // dostaje przeliczone `from`, nie `rangeDays` wprost.
    queryKey: queryKeys.usage({ ...filterParams, rangeDays }),
    // `Date.now()` liczone TUTAJ (w queryFn, poza render-em) — `react-hooks/purity` zakazuje wołania
    // funkcji nieczystych (Date.now/Math.random) bezpośrednio w ciele komponentu/hooków renderujących
    // (useMemo itd.), ale queryFn TanStack Query wykonuje się poza fazą renderu. Serwer domyślnie
    // bierze `to = now()`, więc nie wysyłamy własnego `to` (unika rozjazdu zegara klient/serwer).
    queryFn: () => {
      const from = new Date(Date.now() - rangeDays * DAY_MS).toISOString();
      return api.get<UsageMetrics>(`/metrics/usage${toQueryString({ ...filterParams, from })}`);
    },
  });

  const hasData = !!data && (data.searchSeries.length > 0 || data.proposalSeries.buckets.length > 0);

  return (
    <div className="overflow-y-auto p-6">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Pomiary</h1>
      <p className="mb-5 max-w-2xl text-[13.5px] text-muted-foreground">
        Użycie pamięci przez agentów: liczba wyszukiwań per projekt w czasie, odsetek zapytań bez wyników oraz
        decyzje recenzenta w kolejce (akceptacja / odrzucenie / edycja).
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={String(rangeDays)} onValueChange={(v) => setRangeDays(Number(v) as RangeDays)}>
          <SelectTrigger className="h-8 w-auto gap-1.5 px-2.5 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">ostatnie 7 dni</SelectItem>
            <SelectItem value="30">ostatnie 30 dni</SelectItem>
          </SelectContent>
        </Select>
        <Select value={bucket} onValueChange={(v) => setBucket(v as UsageBucket)}>
          <SelectTrigger className="h-8 w-auto gap-1.5 px-2.5 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">bucket: dzień</SelectItem>
            <SelectItem value="hour">bucket: godzina</SelectItem>
          </SelectContent>
        </Select>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="h-8 w-auto gap-1.5 px-2.5 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">projekt: wszystkie</SelectItem>
            {(projects ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-4 max-w-5xl">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !data || !hasData ? (
        <EmptyState
          icon={Activity}
          title="Brak danych w tym zakresie"
          description="Zmień zakres dat, bucket albo projekt — agenci jeszcze nie wywoływali search_memory w tym oknie."
        />
      ) : (
        <div className="flex max-w-5xl flex-col gap-6">
          {/* Nagłówkowe liczby — sumy dla całego zakresu, tego samego kształtu co pasek zdrowia AppShell. */}
          <section className="flex flex-wrap rounded-lg border border-border bg-surface px-1">
            <MetricStat label="Wyszukiwania" value={data.searchTotals.searches} />
            <MetricStat
              label="Zero wyników"
              value={`${data.searchTotals.zeroResult} (${formatPct(data.searchTotals.zeroResultRate)})`}
              status={data.searchTotals.zeroResultRate >= 0.3 ? 'bad' : data.searchTotals.zeroResultRate >= 0.1 ? 'warn' : 'ok'}
            />
            <MetricStat label="Degradowane (bez wektora)" value={data.searchTotals.degraded} />
            <MetricStat
              label="Zaakceptowane"
              value={`${data.proposalSeries.totals.approved} (z edycją: ${data.proposalSeries.totals.approvedWithEdits})`}
            />
            <MetricStat label="Odrzucone" value={data.proposalSeries.totals.rejected} />
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground">Wyszukiwania per projekt w czasie</h2>
            <div className="rounded-lg border border-border bg-surface p-3">
              <SearchVolumeChart series={data.searchSeries} bucket={data.range.bucket} />
            </div>
          </section>

          <section>
            <h2 className="mb-1 text-sm font-semibold text-foreground">Zero-result rate per projekt</h2>
            <p className="mb-2.5 text-xs text-muted-foreground">
              Odsetek wyszukiwań bez trafień — główny sygnał "czy pamięć ma czym odpowiedzieć". Wyszukiwania
              zdegradowane (provider embeddingów niedostępny) są WYŁĄCZONE z tego wyliczenia, licznik degradacji
              pokazany osobno powyżej.
            </p>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {data.searchSeries.map((s) => (
                <div key={s.projectId} className="rounded-md border border-border bg-surface px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-muted-foreground">{s.projectName}</span>
                    <Badge variant={rateSeverity(s.totals.zeroResultRate)}>{formatPct(s.totals.zeroResultRate)}</Badge>
                  </div>
                  <div className="mt-1 font-mono text-[11px] tabular-nums text-faint">
                    {s.totals.searches} wyszukiwań · {s.totals.zeroResult} bez wyniku · {s.totals.degraded} degradowanych
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-border bg-surface p-3">
              <ZeroResultTrendChart series={data.searchSeries} bucket={data.range.bucket} />
            </div>
          </section>

          <section>
            <h2 className="mb-1 text-sm font-semibold text-foreground">Decyzje w kolejce</h2>
            <p className="mb-2.5 text-xs text-muted-foreground">
              "Zaakceptowane z edycją" to PODZBIÓR zaakceptowanych (recenzent poprawił treść przed zatwierdzeniem),
              nie osobna, rozłączna kategoria. Samo-wycofania nocnego joba (<code>withdrawn</code>) są pominięte —
              to nie decyzja człowieka.
            </p>
            <div className="rounded-lg border border-border bg-surface p-3">
              <ProposalOutcomeChart buckets={data.proposalSeries.buckets} bucket={data.range.bucket} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
