import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { EmptyState } from '../components/EmptyState';
import { KindGutter, KindMarker } from '../components/KindMarker';
import { MonoId } from '../components/MonoId';
import { OriginPath } from '../components/OriginPath';
import { RelationsPanel } from '../components/RelationsPanel';
import { RevisionTimeline, type RevisionItem } from '../components/RevisionTimeline';
import { StatusChip } from '../components/StatusChip';
import { api } from '../lib/api';
import { contextQueryParams, useActiveContext } from '../lib/context';
import { describeApiError } from '../lib/errors';
import { formatAbsoluteTime, formatRelativeTime, toDatetimeLocalValue } from '../lib/format';
import { queryKeys } from '../lib/query';
import { toQueryString } from '../lib/query-string';
import { cn } from '../lib/utils';
import type {
  MemoryDetail,
  MemoryListItem,
  ProjectListItem,
  RelationListItemApi,
  RevisionRowApi,
  WithWarnings,
} from '../types/api';
import type { MemoryKind, MemoryStatus, RelationType } from '../types/domain';
import { PurgeMemoryDialog } from './PurgeMemoryDialog';

type KindFilter = 'all' | MemoryKind;
type StatusFilter = 'all' | MemoryStatus;

function toRevisionItems(rows: RevisionRowApi[]): RevisionItem[] {
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor: r.actor,
    createdAt: r.createdAt,
    supersedes: r.supersedes,
    supersededBy: r.supersededBy,
  }));
}

export function MemoryBrowserScreen() {
  const { active } = useActiveContext();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [kind, setKind] = useState<KindFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [tagsInput, setTagsInput] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  // `selectedId` pochodzi WYŁĄCZNIE z URL (§CommandPalette deep-link `/pamiec?id=`) — brak osobnego
  // stanu do zsynchronizowania efektem (react-hooks/set-state-in-effect, React Compiler): `select()`
  // niżej po prostu zapisuje do URL, a ten render czyta z niego bezpośrednio.
  const selectedId = searchParams.get('id');
  const [editingForId, setEditingForId] = useState<string | null>(null);
  const editing = editingForId !== null && editingForId === selectedId;
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  // Wybranie innej pamięci z listy/rewizji/relacji podczas edycji odmontowuje `MemoryEditForm`
  // (bo `editing` zależy od `selectedId`) i po cichu gubi niezapisane zmiany — dlatego `select()`
  // przechodzi przez to potwierdzenie zamiast przełączać `selectedId` od razu.
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  // Roadmap v1.2 ("memory-relations + 1-hop graph boost") — id relacji aktualnie usuwanej (disable
  // TYLKO jej przycisku "Usuń", nie całej zakładki, przy wielu relacjach naraz).
  const [removingRelationId, setRemovingRelationId] = useState<string | null>(null);
  const [tabState, setTabState] = useState<{ id: string; tab: string } | null>(null);
  const tab = tabState && tabState.id === selectedId ? tabState.tab : 'body';

  useEffect(() => {
    const handle = setTimeout(() => setQ(qInput.trim()), 400);
    return () => clearTimeout(handle);
  }, [qInput]);

  function setTab(next: string): void {
    if (selectedId) setTabState({ id: selectedId, tab: next });
  }

  const tags = tagsInput
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const filterParams: Record<string, string | string[]> = { ...contextQueryParams(active) };
  if (kind !== 'all') filterParams.kind = kind;
  if (status !== 'all') filterParams.status = status;
  if (tags.length > 0) filterParams.tags = tags;
  if (q) filterParams.q = q;

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.memories(filterParams),
    queryFn: () => api.get<MemoryListItem[]>(`/memories${toQueryString(filterParams)}`),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectListItem[]>('/projects'),
  });

  const list = data ?? [];

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: queryKeys.memory(selectedId ?? ''),
    queryFn: () => api.get<MemoryDetail>(`/memories/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  const { data: revisions } = useQuery({
    queryKey: queryKeys.memoryRevisions(selectedId ?? ''),
    queryFn: () => api.get<RevisionRowApi[]>(`/memories/${selectedId}/revisions`),
    enabled: Boolean(selectedId),
  });

  const { data: relations, isLoading: relationsLoading } = useQuery({
    queryKey: queryKeys.memoryRelations(selectedId ?? ''),
    queryFn: () => api.get<RelationListItemApi[]>(`/memories/${selectedId}/relations`),
    enabled: Boolean(selectedId),
  });

  function selectNow(id: string): void {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('id', id);
      return next;
    });
  }

  function select(id: string): void {
    if (editing && id !== selectedId) {
      setPendingSelectId(id);
      return;
    }
    selectNow(id);
  }

  function confirmDiscardAndSelect(): void {
    if (!pendingSelectId) return;
    setEditingForId(null);
    selectNow(pendingSelectId);
    setPendingSelectId(null);
  }

  function invalidateMemory(id: string): void {
    queryClient.invalidateQueries({ queryKey: ['memories'] });
    queryClient.invalidateQueries({ queryKey: queryKeys.memory(id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.memoryRevisions(id) });
    // Archiwizacja usuwa krawędzie grafu po stronie serwera (roadmap v1.2) — odświeżamy razem
    // z resztą, żeby zakładka "Relacje" nigdy nie pokazywała martwych wierszy.
    queryClient.invalidateQueries({ queryKey: queryKeys.memoryRelations(id) });
  }

  const editMutation = useMutation({
    mutationFn: (vars: { id: string; header: string; body: string; tags: string[]; eventTime?: string }) =>
      api.patch<WithWarnings>(`/memories/${vars.id}`, {
        header: vars.header,
        body: vars.body,
        tags: vars.tags,
        ...(vars.eventTime !== undefined ? { eventTime: vars.eventTime } : {}),
      }),
    onSuccess: (result, vars) => {
      setEditingForId(null);
      if (result.warnings.length > 0) {
        for (const w of result.warnings) toast.warning(w);
      } else {
        toast.success('Zapisano');
      }
      invalidateMemory(vars.id);
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/memories/${id}/archive`),
    onSuccess: (_r, id) => {
      toast('Zarchiwizowano');
      setArchiveOpen(false);
      invalidateMemory(id);
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const promoteMutation = useMutation({
    mutationFn: (id: string) => api.post(`/memories/${id}/promote`),
    onSuccess: (_r, id) => {
      toast.success('Promowano do global');
      invalidateMemory(id);
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const createRelationMutation = useMutation({
    mutationFn: (vars: { id: string; type: RelationType; targetId: string }) =>
      api.post<{ id: string }>(`/memories/${vars.id}/relations`, { toId: vars.targetId, type: vars.type }),
    onSuccess: (_r, vars) => {
      toast.success('Dodano relację');
      queryClient.invalidateQueries({ queryKey: queryKeys.memoryRelations(vars.id) });
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const removeRelationMutation = useMutation({
    mutationFn: (vars: { id: string; relationId: string }) =>
      api.del(`/memories/${vars.id}/relations/${vars.relationId}`),
    onMutate: (vars) => setRemovingRelationId(vars.relationId),
    onSuccess: (_r, vars) => {
      toast('Usunięto relację');
      queryClient.invalidateQueries({ queryKey: queryKeys.memoryRelations(vars.id) });
    },
    onError: (err) => toast.error(describeApiError(err)),
    onSettled: () => setRemovingRelationId(null),
  });

  return (
    <div className="grid h-full min-h-0" style={{ gridTemplateColumns: 'minmax(320px, 38%) 1fr' }}>
      <div className="flex min-w-0 flex-col border-r border-border-strong">
        <div className="flex h-auto flex-none flex-wrap items-center gap-2 border-b border-border px-3.5 py-2">
          <Select value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
            <SelectTrigger className="h-7 gap-1.5 px-2 text-[12px]">
              <SelectValue placeholder="kind" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">kind: wszystkie</SelectItem>
              <SelectItem value="fact">fact</SelectItem>
              <SelectItem value="document">document</SelectItem>
              <SelectItem value="event">event</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="h-7 gap-1.5 px-2 text-[12px]">
              <SelectValue placeholder="status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">status: wszystkie</SelectItem>
              <SelectItem value="approved">approved</SelectItem>
              <SelectItem value="archived">archived</SelectItem>
              <SelectItem value="purged">purged</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="tagi (po przecinku)"
            className="h-7 w-32 text-[12px]"
          />
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="szukaj…"
            className="h-7 flex-1 min-w-[120px] text-[12px]"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex flex-col gap-2 p-3.5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : list.length === 0 ? (
            <EmptyState title="Brak pamięci" description="Zmień filtry albo kontekst — nic tu nie pasuje." />
          ) : (
            list.map((item) => (
              <MemoryRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                projectName={projects?.find((p) => p.id === item.projectId)?.name ?? null}
                onClick={() => select(item.id)}
              />
            ))
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-col bg-surface">
        {!selectedId ? (
          <EmptyState title="Wybierz pamięć z listy" description="Szczegóły pojawią się tutaj." />
        ) : detailLoading || !detail ? (
          <div className="p-6">
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="mb-1 flex items-start gap-3">
                <h2 className="flex-1 text-lg font-medium leading-snug tracking-tight text-foreground">{detail.header}</h2>
                <StatusChip status={detail.status} />
              </div>
              <div className="mb-4 flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-border pb-4 text-xs">
                <MonoId value={detail.id} />
                <Dot />
                {/* Ten sam kolor tożsamości co na wierszu listy (§2.4) — wybranie pamięci nie może
                    gubić sygnału, który pomógł ją znaleźć. */}
                <span className="inline-flex items-center gap-1.5">
                  <KindMarker kind={detail.kind} decorative />
                  <span className="font-mono text-faint">{detail.kind}</span>
                </span>
                {detail.kind === 'event' && detail.eventTime && (
                  <>
                    <Dot />
                    <span className="inline-flex items-center gap-1 font-mono text-faint">
                      <Clock className="size-3" />
                      {formatAbsoluteTime(detail.eventTime)}
                    </span>
                  </>
                )}
                <Dot />
                <OriginPath
                  origin={detail.source}
                  scope={detail.scope}
                  projectName={projects?.find((p) => p.id === detail.projectId)?.name ?? null}
                />
                <Dot />
                <span className="font-mono text-faint">
                  access {detail.accessCount} · ostatnio {detail.lastAccessedAt ? formatRelativeTime(detail.lastAccessedAt) : 'nigdy'}
                </span>
              </div>

              <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                  <TabsTrigger value="body">Body</TabsTrigger>
                  <TabsTrigger value="meta">Metadane</TabsTrigger>
                  <TabsTrigger value="revisions">Rewizje ({revisions?.length ?? 0})</TabsTrigger>
                  <TabsTrigger value="relations">Relacje ({relations?.length ?? 0})</TabsTrigger>
                </TabsList>
                <TabsContent value="body" className="pt-4">
                  {editing ? (
                    <MemoryEditForm
                      kind={detail.kind}
                      initialHeader={detail.header}
                      initialBody={detail.body}
                      initialTags={detail.tags}
                      initialEventTime={detail.eventTime}
                      saving={editMutation.isPending}
                      onCancel={() => setEditingForId(null)}
                      onSave={(vars) => editMutation.mutate({ id: detail.id, ...vars })}
                    />
                  ) : (
                    <div className="max-w-[68ch] rounded-md border border-border bg-muted/40 px-4 py-3 text-md leading-relaxed text-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.body}</ReactMarkdown>
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="meta" className="pt-4">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-sm">
                    <dt className="text-muted-foreground">Scope</dt>
                    <dd className="font-mono text-xs">
                      {detail.scope}
                      {detail.projectId ? ` · ${detail.projectId}` : ''}
                    </dd>
                    <dt className="text-muted-foreground">Source</dt>
                    <dd className="font-mono text-xs">{detail.source}</dd>
                    <dt className="text-muted-foreground">Wersja</dt>
                    <dd className="font-mono text-xs">{detail.version}</dd>
                    <dt className="text-muted-foreground">Utworzono</dt>
                    <dd className="font-mono text-xs">{formatAbsoluteTime(detail.createdAt)}</dd>
                    <dt className="text-muted-foreground">Zaktualizowano</dt>
                    <dd className="font-mono text-xs">{formatAbsoluteTime(detail.updatedAt)}</dd>
                    <dt className="text-muted-foreground">Zatwierdzono</dt>
                    <dd className="font-mono text-xs">{detail.approvedAt ? formatAbsoluteTime(detail.approvedAt) : '—'}</dd>
                    {detail.kind === 'event' && (
                      <>
                        <dt className="text-muted-foreground">event_time</dt>
                        <dd className="font-mono text-xs">{detail.eventTime ? formatAbsoluteTime(detail.eventTime) : '—'}</dd>
                      </>
                    )}
                    <dt className="text-muted-foreground">Tagi</dt>
                    <dd className="font-mono text-xs">{detail.tags.join(', ') || '—'}</dd>
                  </dl>
                </TabsContent>
                <TabsContent value="revisions" className="pt-4">
                  <RevisionTimeline
                    revisions={toRevisionItems(revisions ?? [])}
                    onSelectMemory={(id) => select(id)}
                  />
                </TabsContent>
                <TabsContent value="relations" className="pt-4">
                  <RelationsPanel
                    canAdd={detail.scope === 'project' && detail.status === 'approved'}
                    projectId={detail.projectId}
                    relations={relations ?? []}
                    isLoading={relationsLoading}
                    creating={createRelationMutation.isPending}
                    removingId={removingRelationId}
                    onCreate={(vars) => createRelationMutation.mutate({ id: detail.id, ...vars })}
                    onRemove={(relationId) => removeRelationMutation.mutate({ id: detail.id, relationId })}
                    onSelectMemory={(id) => select(id)}
                    currentMemoryId={detail.id}
                  />
                </TabsContent>
              </Tabs>
            </div>
            <div className="flex flex-none items-center gap-2 border-t border-border px-6 py-3">
              <Button
                variant="secondary"
                onClick={() => detail && setEditingForId(detail.id)}
                disabled={editing || detail.status !== 'approved'}
              >
                Edytuj
              </Button>
              <Button
                variant="secondary"
                onClick={() => setArchiveOpen(true)}
                disabled={detail.status !== 'approved'}
              >
                Archiwizuj
              </Button>
              {detail.scope === 'project' && (
                <Button
                  variant="secondary"
                  onClick={() => promoteMutation.mutate(detail.id)}
                  disabled={detail.status !== 'approved' || promoteMutation.isPending}
                >
                  Promuj do global
                </Button>
              )}
              <Button
                variant="ghost-danger"
                onClick={() => setPurgeOpen(true)}
                disabled={detail.status === 'purged'}
                className="ml-auto"
              >
                Hard-purge
              </Button>
            </div>
          </>
        )}
      </div>

      <AlertDialog open={pendingSelectId !== null} onOpenChange={(open) => !open && setPendingSelectId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Porzucić niezapisane zmiany?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogDescription>
            Edytujesz tę pamięć i masz niezapisane zmiany. Przełączenie na inną pamięć je odrzuci.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscardAndSelect}>Porzuć i przełącz</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archiwizować pamięć?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogDescription>
            Soft-delete — pamięć zniknie z search, ale zostaje w audycie i da się odtworzyć z rewizji.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction onClick={() => selectedId && archiveMutation.mutate(selectedId)} disabled={archiveMutation.isPending}>
              Archiwizuj
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {detail && (
        <PurgeMemoryDialog
          open={purgeOpen}
          onOpenChange={setPurgeOpen}
          memoryId={detail.id}
          memoryHeader={detail.header}
        />
      )}
    </div>
  );
}

function MemoryRow({
  item,
  selected,
  onClick,
  projectName,
}: {
  item: MemoryListItem;
  selected: boolean;
  onClick: () => void;
  projectName: string | null;
}) {
  const visibleTags = item.tags.slice(0, 2);
  const hidden = item.tags.length - visibleTags.length;
  const isDocument = item.kind === 'document';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-selected={selected}
      className={cn(
        // §2.4 — `kind` niesie kształt (gutter), ikonę (KindMarker) i kolor; `document` dostaje
        // dodatkowo własny rytm (nagłówek zawija się do dwóch linii zamiast się urywać), więc
        // różni się sylwetką wiersza, nie samym tintem. Stąd `items-start` i zmienna wysokość.
        'relative grid min-h-[56px] cursor-pointer grid-cols-[auto_1fr_auto] items-start gap-2.5 border-b border-border py-2.5 pl-4 pr-3.5',
        'hover:bg-muted focus-visible:outline-none',
        selected && 'bg-accent-subtle',
        item.status !== 'approved' && 'opacity-60',
      )}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-[2px] bg-primary" aria-hidden />
      ) : (
        <KindGutter kind={item.kind} />
      )}
      <KindMarker kind={item.kind} className="mt-px shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <div
          className={cn(
            'min-w-0 text-[13.5px] font-medium text-foreground',
            isDocument ? 'line-clamp-2 leading-snug' : 'truncate',
          )}
        >
          {item.header}
        </div>
        <div className="flex min-w-0 items-center gap-2.5">
          {item.kind === 'event' && item.eventTime && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs font-medium text-[var(--kind-event-foreground)]">
              <Clock className="size-3" />
              {formatAbsoluteTime(item.eventTime)}
            </span>
          )}
          <OriginPath origin={item.source} scope={item.scope} projectName={projectName} />
          {item.tags.length > 0 && (
            <span className="flex min-w-0 gap-1">
              {visibleTags.map((tag) => (
                <span
                  key={tag}
                  className="whitespace-nowrap rounded-[4px] border border-border bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
              {hidden > 0 && (
                <span className="whitespace-nowrap rounded-[4px] border border-border bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                  +{hidden}
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 pt-0.5">
        <span className="whitespace-nowrap font-mono text-[11px] text-faint">acc {item.accessCount}</span>
        {item.status !== 'approved' && <StatusChip status={item.status} />}
      </div>
    </div>
  );
}

function MemoryEditForm({
  kind,
  initialHeader,
  initialBody,
  initialTags,
  initialEventTime,
  onCancel,
  onSave,
  saving,
}: {
  kind: MemoryKind;
  initialHeader: string;
  initialBody: string;
  initialTags: string[];
  initialEventTime: string | null;
  onCancel: () => void;
  onSave: (vars: { header: string; body: string; tags: string[]; eventTime?: string }) => void;
  saving: boolean;
}) {
  const [header, setHeader] = useState(initialHeader);
  const [body, setBody] = useState(initialBody);
  const [tagsInput, setTagsInput] = useState(initialTags.join(', '));
  // `initialEventTime` jest `null` dla fact/document — fallback na "teraz" nie ma tu znaczenia
  // (pole renderuje się tylko gdy kind==='event', gdzie eventTime zawsze jest ustawiony).
  const [eventTime, setEventTime] = useState(() =>
    toDatetimeLocalValue(initialEventTime ? new Date(initialEventTime) : new Date()),
  );
  const eventTimeInvalid = kind === 'event' && Number.isNaN(new Date(eventTime).getTime());

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
        Nagłówek
        <Input value={header} onChange={(e) => setHeader(e.target.value)} maxLength={200} />
      </label>
      {kind === 'event' && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Kiedy się wydarzyło</span>
          <Input
            type="datetime-local"
            value={eventTime}
            onChange={(e) => setEventTime(e.target.value)}
            className={eventTimeInvalid ? 'border-danger' : undefined}
          />
          <span className="text-2xs text-faint">
            Backdatable — możesz cofnąć na dowolną wcześniejszą datę. Przyszłe daty też są dozwolone.
          </span>
        </label>
      )}
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
        Treść
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} />
      </label>
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
        Tagi (po przecinku)
        <Input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          Anuluj
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={saving || eventTimeInvalid}
          onClick={() =>
            onSave({
              header,
              body,
              tags: tagsInput
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
              eventTime: kind === 'event' ? new Date(eventTime).toISOString() : undefined,
            })
          }
        >
          {saving ? 'Zapisywanie…' : 'Zapisz'}
        </Button>
      </div>
    </div>
  );
}

function Dot() {
  return <span className="size-[3px] rounded-full bg-border-strong" aria-hidden />;
}
