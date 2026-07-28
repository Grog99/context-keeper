import { useQuery } from '@tanstack/react-query';
import { Clock, History } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { EmptyState } from '../components/EmptyState';
import { OriginPath } from '../components/OriginPath';
import { ScreenContainer } from '../components/ScreenContainer';
import { api } from '../lib/api';
import { contextQueryParams, useActiveContext } from '../lib/context';
import { dayKey, formatDayHeading, formatTimeOfDay } from '../lib/format';
import { queryKeys } from '../lib/query';
import { toQueryString } from '../lib/query-string';
import type { MemoryListItem } from '../types/api';

interface DayGroup {
  key: string;
  heading: string;
  items: MemoryListItem[];
}

/** Grupuje eventy (już posortowane `event_time DESC` przez backend) wg dnia kalendarzowego lokalnego
 * — jeden przebieg, kolejność wejściowa zachowana wewnątrz grupy (§Plan "grupowanie wg dnia"). */
function groupByDay(items: MemoryListItem[]): DayGroup[] {
  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();
  for (const item of items) {
    if (!item.eventTime) continue; // defensywnie — /events zwraca wyłącznie kind=event z event_time
    const key = dayKey(item.eventTime);
    let group = byKey.get(key);
    if (!group) {
      group = { key, heading: formatDayHeading(item.eventTime), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/**
 * §9 design-systemu — ekran "Oś czasu" (roadmap v1.2, "kind=event episodic"): chronologiczna lista
 * `kind=event`, grupowana wg dnia (nagłówek dnia + wpisy pod spodem, "ruled ledger" jak reszta
 * dashboardu). Scoped przez `ContextSwitcher` jak `MemoryBrowserScreen` (§9.6). Klik na wiersz
 * otwiera pełny szczegół w "Pamięć" (`/pamiec?id=`) — ten ekran sam nie duplikuje panelu detalu.
 */
export function OsCzasuScreen() {
  const { active } = useActiveContext();
  const navigate = useNavigate();

  const filterParams = contextQueryParams(active);
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.events(filterParams),
    queryFn: () => api.get<MemoryListItem[]>(`/memories/events${toQueryString(filterParams)}`),
  });

  const groups = groupByDay(data ?? []);

  return (
    <ScreenContainer width="list">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Oś czasu</h1>
      <p className="mb-5 max-w-2xl text-[13.5px] text-muted-foreground">
        Zdarzenia (<span className="font-mono">kind=event</span>) w kolejności chronologicznej, wg{' '}
        <span className="font-mono">event_time</span>. Tworzone wyłącznie przez człowieka w „Nowa pamięć".
      </p>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={History}
          title="Brak zdarzeń"
          description="Utwórz pierwsze zdarzenie z panelu „Nowa pamięć” (kind: Zdarzenie)."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <div key={group.key}>
              <h2 className="mb-2 border-b border-border pb-1.5 text-xs font-semibold uppercase tracking-[0.05em] text-faint">
                {group.heading}
              </h2>
              <div className="overflow-hidden rounded-lg border border-border bg-surface">
                {group.items.map((item, i) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(`/pamiec?id=${item.id}`)}
                    className={
                      'flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ' +
                      (i > 0 ? 'border-t border-border' : '')
                    }
                  >
                    <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs tabular-nums text-faint">
                      <Clock className="size-3" />
                      {formatTimeOfDay(item.eventTime!)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">
                      {item.header}
                    </span>
                    <OriginPath origin={item.source} scope={item.scope} className="shrink-0" />
                    {item.tags.length > 0 && (
                      <span className="hidden shrink-0 items-center gap-1 sm:flex">
                        {item.tags.slice(0, 2).map((tag) => (
                          <Badge key={tag} variant="neutral" className="normal-case tracking-normal">
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </ScreenContainer>
  );
}
