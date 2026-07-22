import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  CircleCheck,
  DatabaseBackup,
  KeyRound,
  Moon,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Badge, type BadgeProps } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { api } from '../lib/api';
import { formatAbsoluteTime } from '../lib/format';
import { queryKeys } from '../lib/query';
import { toQueryString } from '../lib/query-string';
import type { AuditLogRowApi, ProjectListItem } from '../types/api';
import type { AuditEventType } from '../types/domain';

type EventFilter = 'all' | AuditEventType;

const EVENT_TYPES: AuditEventType[] = [
  'proposal_created',
  'proposal_approved',
  'proposal_rejected',
  'proposal_edited',
  'human_edit',
  'archive',
  'promote',
  'token_created',
  'token_rotated',
  'secret_blocked',
  'purge_tombstone',
  'nightly_run',
  'backup_completed',
];

const EVENT_CONFIG: Record<AuditEventType, { icon: LucideIcon; variant: NonNullable<BadgeProps['variant']> }> = {
  proposal_created: { icon: Plus, variant: 'info' },
  proposal_approved: { icon: CircleCheck, variant: 'success' },
  proposal_rejected: { icon: X, variant: 'neutral' },
  proposal_edited: { icon: Pencil, variant: 'info' },
  human_edit: { icon: Pencil, variant: 'success' },
  archive: { icon: Archive, variant: 'neutral' },
  promote: { icon: CircleCheck, variant: 'success' },
  token_created: { icon: KeyRound, variant: 'success' },
  token_rotated: { icon: KeyRound, variant: 'pending' },
  secret_blocked: { icon: ShieldAlert, variant: 'danger' },
  purge_tombstone: { icon: Trash2, variant: 'danger' },
  nightly_run: { icon: Moon, variant: 'info' },
  backup_completed: { icon: DatabaseBackup, variant: 'info' },
};

function EventBadge({ eventType }: { eventType: AuditEventType }) {
  const { icon: Icon, variant } = EVENT_CONFIG[eventType];
  return (
    <Badge variant={variant} className="normal-case tracking-normal">
      <Icon className="size-3" />
      {eventType}
    </Badge>
  );
}

/** §9.4 design-systemu — tabela zdarzeń filtrowalna po `event_type`/zakresie czasu/projekcie.
 * `secret_blocked` wyróżniony wierszem danger + CTA "Rotuj credential →" (link na Projekty, bo tam
 * żyje rotacja tokenów, §FR-D3). */
export function AuditScreen() {
  const [eventType, setEventType] = useState<EventFilter>('all');
  const [projectId, setProjectId] = useState<string>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<AuditLogRowApi[]>([]);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectListItem[]>('/projects'),
  });

  const filterParams: Record<string, string> = {};
  if (eventType !== 'all') filterParams.eventType = eventType;
  if (projectId !== 'all') filterParams.projectId = projectId;
  if (from) filterParams.from = new Date(from).toISOString();
  if (to) filterParams.to = new Date(to).toISOString();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: queryKeys.audit({ ...filterParams, cursor }),
    queryFn: () => api.get<AuditLogRowApi[]>(`/audit${toQueryString({ ...filterParams, cursor })}`),
  });

  const allRows = cursor ? [...rows, ...(data ?? [])] : (data ?? []);

  function resetAndFilter<T>(setter: (value: T) => void, value: T): void {
    setCursor(undefined);
    setRows([]);
    setter(value);
  }

  function loadMore(): void {
    if (!data || data.length === 0) return;
    setRows(allRows);
    setCursor(data[data.length - 1].createdAt);
  }

  return (
    <div className="overflow-y-auto p-6">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Audyt</h1>
      <p className="mb-5 max-w-2xl text-[13.5px] text-muted-foreground">
        Append-only log zdarzeń zmieniających stan pamięci. Filtrowalny po typie zdarzenia, zakresie czasu i projekcie.
      </p>

      <div className="mb-3.5 flex flex-wrap gap-2">
        <Select value={eventType} onValueChange={(v) => resetAndFilter(setEventType, v as EventFilter)}>
          <SelectTrigger className="h-8 gap-1.5 px-2.5 text-xs">
            <SelectValue placeholder="event_type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">event_type: wszystkie</SelectItem>
            {EVENT_TYPES.map((et) => (
              <SelectItem key={et} value={et}>
                {et}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={projectId} onValueChange={(v) => resetAndFilter(setProjectId, v)}>
          <SelectTrigger className="h-8 gap-1.5 px-2.5 text-xs">
            <SelectValue placeholder="projekt" />
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
        <Input
          type="datetime-local"
          value={from}
          onChange={(e) => resetAndFilter(setFrom, e.target.value)}
          className="h-8 w-auto text-xs"
          aria-label="od"
        />
        <Input
          type="datetime-local"
          value={to}
          onChange={(e) => resetAndFilter(setTo, e.target.value)}
          className="h-8 w-auto text-xs"
          aria-label="do"
        />
      </div>

      {isLoading && !isFetching ? (
        <Skeleton className="h-64 w-full max-w-5xl" />
      ) : allRows.length === 0 ? (
        <EmptyState title="Brak zdarzeń" description="Zmień filtry — nic tu nie pasuje." />
      ) : (
        <div className="max-w-5xl overflow-hidden rounded-lg border border-border">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border">
                  <Th>Czas</Th>
                  <Th>Zdarzenie</Th>
                  <Th>Aktor</Th>
                  <Th>affected_ids</Th>
                  <th className="px-3.5 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">
                    Powiązane
                  </th>
                </tr>
              </thead>
              <tbody>
                {allRows.map((row) => (
                  <tr
                    key={row.id}
                    className={row.eventType === 'secret_blocked' ? 'bg-danger-subtle' : 'border-b border-border last:border-b-0'}
                  >
                    <td className="whitespace-nowrap px-3.5 py-2.5 font-mono text-xs tabular-nums">
                      {formatAbsoluteTime(row.createdAt)}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <EventBadge eventType={row.eventType} />
                    </td>
                    <td className="px-3.5 py-2.5 font-mono text-xs text-muted-foreground">{row.actor}</td>
                    <td className="px-3.5 py-2.5 font-mono text-xs">
                      {row.affectedIds.length === 0
                        ? '—'
                        : row.affectedIds.map((id, i) => (
                            <span key={id}>
                              <Link to={`/pamiec?id=${id}`} className="underline decoration-dotted hover:decoration-solid">
                                {id}
                              </Link>
                              {i < row.affectedIds.length - 1 ? ', ' : ''}
                            </span>
                          ))}
                    </td>
                    <td className="px-3.5 py-2.5 text-right">
                      {row.eventType === 'secret_blocked' ? (
                        <Link to="/projekty" className="text-xs font-semibold text-danger underline">
                          Rotuj credential →
                        </Link>
                      ) : row.revisionId ? (
                        <span className="font-mono text-xs text-muted-foreground">{row.revisionId}</span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && data.length >= 100 && (
            <button
              type="button"
              onClick={loadMore}
              className="w-full border-t border-border py-2.5 text-center text-xs text-muted-foreground hover:bg-muted"
            >
              Załaduj więcej
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: string }) {
  return <th className="px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">{children}</th>;
}
