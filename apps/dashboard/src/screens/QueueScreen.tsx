import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
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
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { Input } from '../components/ui/input';
import { DiffView } from '../components/DiffView';
import { EmptyState } from '../components/EmptyState';
import { MonoId } from '../components/MonoId';
import { OriginPath } from '../components/OriginPath';
import { ProposalActions, type SupersedeCandidate } from '../components/ProposalActions';
import { ProposalRow } from '../components/ProposalRow';
import { StatusChip } from '../components/StatusChip';
import { useQueueKeyboard } from '../hooks/useKeyboard';
import { api } from '../lib/api';
import { useActiveContext, contextQueryParams } from '../lib/context';
import { describeApiError } from '../lib/errors';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/format';
import { queryKeys } from '../lib/query';
import { toQueryString } from '../lib/query-string';
import type { ApproveResult, EditProposalResult, MemoryDetail, ProjectListItem, ProposalView } from '../types/api';
import type { ProposalOrigin, ProposalType, RelationType } from '../types/domain';

type OriginFilter = 'all' | ProposalOrigin;
type TypeFilter = 'all' | ProposalType;

function rowTitle(p: ProposalView): string {
  const effective = p.editedPayload ?? p.payload;
  if (effective.header) return effective.header;
  if (p.type === 'delete') return `Archiwizacja pamięci ${effective.memoryId ?? ''}`.trim();
  if (p.type === 'update') return `Aktualizacja pamięci ${effective.memoryId ?? ''}`.trim();
  return `(propozycja ${p.id})`;
}

function projectNameFor(projectId: string | null, projects: ProjectListItem[] | undefined): string | null {
  if (!projectId || !projects) return null;
  return projects.find((p) => p.id === projectId)?.name ?? null;
}

/** Fetch before/merge-source memories dla detalu (§DiffView, M4) — `create` nie potrzebuje niczego
 * poza payloadem, `update`/`delete` potrzebują aktualnego stanu (`before`), `merge` potrzebuje
 * nagłówków każdego źródła w `affectedIds`. Robione TYLKO dla zaznaczonej propozycji, nie całej listy.
 *
 * Dociąga też nagłówki targetów attach-on-save `relations` (roadmap v1.2, FINDING 1 review PR #15)
 * — TYM SAMYM `GET /memories/:id` co `beforeQuery`/`mergeQueries` (współdzielony cache przez
 * `queryKeys.memory`), celowo bez nowego endpointu. `retry: false` + fail-open na brak danych: target
 * mógł zniknąć (archiwizacja/purge) między `save()` a przeglądem — `ProposalRelations` wtedy po
 * prostu pokazuje sam `targetId` (ten sam fail-open co `materializeRelations` po stronie serwera). */
function useProposalDetailData(proposal: ProposalView | undefined) {
  const effective = proposal ? (proposal.editedPayload ?? proposal.payload) : undefined;
  const beforeId = proposal && (proposal.type === 'update' || proposal.type === 'delete') ? effective?.memoryId : undefined;
  const mergeIds = proposal?.type === 'merge' ? proposal.affectedIds : [];
  const relationTargetIds = Array.from(new Set((effective?.relations ?? []).map((r) => r.targetId)));

  const beforeQuery = useQuery({
    queryKey: queryKeys.memory(beforeId ?? ''),
    queryFn: () => api.get<MemoryDetail>(`/memories/${beforeId}`),
    enabled: Boolean(beforeId),
  });

  const mergeQueries = useQueries({
    queries: mergeIds.map((id) => ({
      queryKey: queryKeys.memory(id),
      queryFn: () => api.get<MemoryDetail>(`/memories/${id}`),
    })),
  });

  const relationTargetQueries = useQueries({
    queries: relationTargetIds.map((id) => ({
      queryKey: queryKeys.memory(id),
      queryFn: () => api.get<MemoryDetail>(`/memories/${id}`),
      retry: false,
    })),
  });
  const relationHeaders = new Map<string, string>();
  relationTargetIds.forEach((id, i) => {
    const header = relationTargetQueries[i]?.data?.header;
    if (header) relationHeaders.set(id, header);
  });

  return {
    beforeMemory: beforeId ? beforeQuery.data : undefined,
    beforeLoading: Boolean(beforeId) && beforeQuery.isLoading,
    mergeMemories: mergeQueries.map((q) => q.data).filter((d): d is MemoryDetail => Boolean(d)),
    mergeLoading: mergeIds.length > 0 && mergeQueries.some((q) => q.isLoading),
    relationHeaders,
  };
}

export function QueueScreen() {
  const { active } = useActiveContext();
  const queryClient = useQueryClient();

  const [origin, setOrigin] = useState<OriginFilter>('all');
  const [type, setType] = useState<TypeFilter>('all');
  // Hint, nie prawda absolutna — po zniknięciu propozycji z listy (approve/reject/refetch) po prostu
  // nie znajdziemy jej niżej i spadniemy na pierwszy element listy, w tym samym renderze (bez efektu
  // korygującego stan, react-hooks/set-state-in-effect / React Compiler).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingForId, setEditingForId] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [tabState, setTabState] = useState<{ id: string; tab: string } | null>(null);
  const [, setTick] = useState(0);
  const detailRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const filterParams: Record<string, string> = { ...contextQueryParams(active) };
  if (origin !== 'all') filterParams.origin = origin;
  if (type !== 'all') filterParams.type = type;

  const {
    data,
    isLoading,
    isFetching,
    dataUpdatedAt,
    refetch,
  } = useQuery({
    queryKey: queryKeys.proposals(filterParams),
    queryFn: () => api.get<ProposalView[]>(`/proposals${toQueryString(filterParams)}`),
    refetchInterval: 15_000,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectListItem[]>('/projects'),
  });

  const proposalsList = data ?? [];

  // Fallback na pierwszy element listy gdy `selectedId` zniknął (zatwierdzone/odrzucone/przefiltrowane)
  // — liczone na bieżąco w renderze, bez efektu synchronizującego stan (patrz komentarz przy stanie wyżej).
  const rawIndex = proposalsList.findIndex((p) => p.id === selectedId);
  const selectedIndex = rawIndex >= 0 ? rawIndex : proposalsList.length > 0 ? 0 : -1;
  const selected = selectedIndex >= 0 ? proposalsList[selectedIndex] : undefined;
  const editing = editingForId !== null && editingForId === selected?.id;
  const tab = tabState && tabState.id === selected?.id ? tabState.tab : 'diff';
  function setTab(next: string): void {
    if (selected) setTabState({ id: selected.id, tab: next });
  }
  const { beforeMemory, beforeLoading, mergeMemories, mergeLoading, relationHeaders } = useProposalDetailData(selected);

  function invalidateAfterMutation(): void {
    queryClient.invalidateQueries({ queryKey: ['proposals'] });
    queryClient.invalidateQueries({ queryKey: queryKeys.metrics() });
  }

  const approveMutation = useMutation({
    mutationFn: (vars: { id: string; supersedes?: string }) =>
      api.post<ApproveResult>(`/proposals/${vars.id}/approve`, vars.supersedes ? { supersedes: vars.supersedes } : {}),
    onSuccess: () => {
      toast.success('Zatwierdzono — pamięć zmaterializowana');
      invalidateAfterMutation();
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const rejectMutation = useMutation({
    mutationFn: (vars: { id: string; reason?: string }) => api.post(`/proposals/${vars.id}/reject`, { reason: vars.reason }),
    onSuccess: () => {
      toast('Odrzucono — zapisane w audycie');
      setRejectOpen(false);
      setRejectReason('');
      invalidateAfterMutation();
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const editMutation = useMutation({
    mutationFn: (vars: { id: string; header: string; body: string; tags: string[] }) =>
      api.patch<EditProposalResult>(`/proposals/${vars.id}`, { header: vars.header, body: vars.body, tags: vars.tags }),
    onSuccess: (result) => {
      setEditingForId(null);
      if (result.warnings.length > 0) {
        for (const w of result.warnings) toast.warning(w);
      } else {
        toast.success('Zapisano edycję (do zatwierdzenia)');
      }
      queryClient.invalidateQueries({ queryKey: ['proposals'] });
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  async function searchSupersedeCandidates(query: string): Promise<SupersedeCandidate[]> {
    if (!selected) return [];
    const params: Record<string, string> = { q: query, status: 'approved' };
    if (selected.scope === 'project' && selected.projectId) {
      params.scope = 'project';
      params.projectId = selected.projectId;
    } else if (selected.scope === 'global') {
      params.scope = 'global';
    }
    const results = await api.get<{ id: string; header: string }[]>(`/memories${toQueryString(params)}`);
    return results.map((m) => ({ id: m.id, header: m.header }));
  }

  function handleApprove(): void {
    if (!selected) return;
    approveMutation.mutate({ id: selected.id });
  }

  function handleApproveAsReplacement(targetId: string): void {
    if (!selected) return;
    if (selected.type !== 'create') {
      toast.error('Zamiennik dostępny tylko dla propozycji typu create.');
      return;
    }
    approveMutation.mutate({ id: selected.id, supersedes: targetId });
  }

  function handleReject(): void {
    if (!selected) return;
    setRejectOpen(true);
  }

  function confirmReject(): void {
    if (!selected) return;
    rejectMutation.mutate({ id: selected.id, reason: rejectReason.trim() || undefined });
  }

  function handleEdit(): void {
    if (!selected) return;
    setEditingForId(selected.id);
    setTab('diff');
  }

  function handleSupersedeShortcut(): void {
    actionsRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.click();
  }

  useQueueKeyboard({
    enabled: !editing && !rejectOpen,
    onNext: () => {
      if (proposalsList.length === 0) return;
      const next = Math.min(selectedIndex + 1, proposalsList.length - 1);
      setSelectedId(proposalsList[Math.max(next, 0)].id);
    },
    onPrev: () => {
      if (proposalsList.length === 0) return;
      const prev = Math.max(selectedIndex - 1, 0);
      setSelectedId(proposalsList[prev].id);
    },
    onOpen: () => detailRef.current?.focus(),
    onApprove: handleApprove,
    onReject: handleReject,
    onEdit: handleEdit,
    onSupersede: handleSupersedeShortcut,
  });

  const lastUpdatedLabel = dataUpdatedAt ? formatRelativeTime(new Date(dataUpdatedAt).toISOString()) : '—';

  return (
    <div className="grid h-full min-h-0" style={{ gridTemplateColumns: 'minmax(320px, 38%) 1fr' }}>
      <div className="flex min-w-0 flex-col border-r border-border-strong">
        <div className="flex h-[46px] flex-none items-center gap-2 border-b border-border px-3.5">
          <Select value={origin} onValueChange={(v) => setOrigin(v as OriginFilter)}>
            <SelectTrigger className="h-7 gap-1.5 px-2 text-[12px]">
              <SelectValue placeholder="origin" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">origin: wszystkie</SelectItem>
              <SelectItem value="agent">agent</SelectItem>
              <SelectItem value="human">human</SelectItem>
              <SelectItem value="nightly">nightly</SelectItem>
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={(v) => setType(v as TypeFilter)}>
            <SelectTrigger className="h-7 gap-1.5 px-2 text-[12px]">
              <SelectValue placeholder="type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">type: wszystkie</SelectItem>
              <SelectItem value="create">create</SelectItem>
              <SelectItem value="update">update</SelectItem>
              <SelectItem value="merge">merge</SelectItem>
              <SelectItem value="delete">delete</SelectItem>
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => refetch()}
            className="ml-auto flex items-center gap-1.5 text-[11px] text-faint hover:text-muted-foreground"
          >
            <RefreshCw className={isFetching ? 'size-3 animate-spin' : 'size-3'} />
            {lastUpdatedLabel}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex flex-col gap-2 p-3.5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : proposalsList.length === 0 ? (
            <EmptyState
              title="Inbox zero — brak propozycji do przeglądu"
              description="Nowe zapisy agentów i propozycje nocnego jobu pojawią się tutaj."
            />
          ) : (
            proposalsList.map((p) => (
              <ProposalRow
                key={p.id}
                type={p.type}
                status="pending"
                title={rowTitle(p)}
                origin={p.origin}
                scope={p.scope}
                projectName={projectNameFor(p.projectId, projects)}
                tags={(p.editedPayload ?? p.payload).tags ?? []}
                createdAt={p.createdAt}
                stale={p.stale}
                selected={p.id === selectedId}
                onClick={() => setSelectedId(p.id)}
              />
            ))
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-col bg-surface" ref={detailRef} tabIndex={-1}>
        {!selected ? (
          <EmptyState title="Wybierz propozycję z listy" description="Szczegóły pojawią się tutaj." />
        ) : (
          <ProposalDetail
            proposal={selected}
            projectName={projectNameFor(selected.projectId, projects)}
            beforeMemory={beforeMemory}
            beforeLoading={beforeLoading}
            mergeMemories={mergeMemories}
            mergeLoading={mergeLoading}
            relationHeaders={relationHeaders}
            editing={editing}
            onCancelEdit={() => setEditingForId(null)}
            onSaveEdit={(vars) => editMutation.mutate({ id: selected.id, ...vars })}
            savingEdit={editMutation.isPending}
            tab={tab}
            onTabChange={setTab}
            actionsRef={actionsRef}
            onApprove={handleApprove}
            onReject={handleReject}
            onEdit={handleEdit}
            onApproveAsReplacement={handleApproveAsReplacement}
            searchSupersedeCandidates={selected.type === 'create' ? searchSupersedeCandidates : undefined}
            busy={approveMutation.isPending || rejectMutation.isPending}
            position={`${selectedIndex + 1} / ${proposalsList.length}`}
          />
        )}
      </div>

      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Odrzucić propozycję?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogDescription>
            Trafi do audytu jako <span className="font-mono">rejected</span>. Nic nie wejdzie do pamięci.
          </AlertDialogDescription>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Powód (opcjonalnie)…"
            rows={3}
            className="mb-2"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReject} disabled={rejectMutation.isPending}>
              Odrzuć
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface ProposalDetailProps {
  proposal: ProposalView;
  projectName: string | null;
  beforeMemory: MemoryDetail | undefined;
  beforeLoading: boolean;
  mergeMemories: MemoryDetail[];
  mergeLoading: boolean;
  relationHeaders: Map<string, string>;
  editing: boolean;
  onCancelEdit: () => void;
  onSaveEdit: (vars: { header: string; body: string; tags: string[] }) => void;
  savingEdit: boolean;
  tab: string;
  onTabChange: (tab: string) => void;
  actionsRef: RefObject<HTMLDivElement | null>;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
  onApproveAsReplacement: (id: string) => void;
  searchSupersedeCandidates?: (query: string) => Promise<SupersedeCandidate[]>;
  busy: boolean;
  position: string;
}

function ProposalDetail({
  proposal,
  projectName,
  beforeMemory,
  beforeLoading,
  mergeMemories,
  mergeLoading,
  relationHeaders,
  editing,
  onCancelEdit,
  onSaveEdit,
  savingEdit,
  tab,
  onTabChange,
  actionsRef,
  onApprove,
  onReject,
  onEdit,
  onApproveAsReplacement,
  searchSupersedeCandidates,
  busy,
  position,
}: ProposalDetailProps) {
  const effective = proposal.editedPayload ?? proposal.payload;
  const title =
    proposal.type === 'delete'
      ? (beforeMemory?.header ?? effective.memoryId ?? proposal.id)
      : (effective.header ?? beforeMemory?.header ?? `(propozycja ${proposal.id})`);
  const tags = effective.tags ?? beforeMemory?.tags ?? [];

  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-1 flex items-start gap-3">
          <h2 className="flex-1 text-lg font-medium leading-snug tracking-tight text-foreground">{title}</h2>
          {proposal.editedPayload && <Badge variant="info">edytowano</Badge>}
          <StatusChip status={proposal.stale ? 'stale' : 'pending'} />
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-border pb-4 text-xs">
          <MonoId value={proposal.id} />
          <Dot />
          <OriginPath origin={proposal.origin} scope={proposal.scope} projectName={projectName} />
          <Dot />
          <span className="text-faint">type: {proposal.type}</span>
          {tags.length > 0 && (
            <>
              <Dot />
              <span className="font-mono text-faint">{tags.map((t) => `#${t}`).join(' ')}</span>
            </>
          )}
        </div>

        {effective.relations && effective.relations.length > 0 && (
          <ProposalRelations relations={effective.relations} headers={relationHeaders} />
        )}

        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList>
            <TabsTrigger value="diff">Diff</TabsTrigger>
            <TabsTrigger value="meta">Metadane</TabsTrigger>
            <TabsTrigger value="revisions">Rewizje</TabsTrigger>
          </TabsList>
          <TabsContent value="diff" className="pt-4">
            {editing ? (
              <EditProposalForm
                initialHeader={effective.header ?? beforeMemory?.header ?? ''}
                initialBody={effective.body ?? beforeMemory?.body ?? ''}
                initialTags={tags}
                onCancel={onCancelEdit}
                onSave={onSaveEdit}
                saving={savingEdit}
              />
            ) : (
              <ProposalDiff proposal={proposal} beforeMemory={beforeMemory} beforeLoading={beforeLoading} mergeMemories={mergeMemories} mergeLoading={mergeLoading} />
            )}
          </TabsContent>
          <TabsContent value="meta" className="pt-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-sm">
              <dt className="text-muted-foreground">Utworzono</dt>
              <dd className="font-mono text-xs">{formatAbsoluteTime(proposal.createdAt)}</dd>
              <dt className="text-muted-foreground">Zaktualizowano</dt>
              <dd className="font-mono text-xs">{formatAbsoluteTime(proposal.updatedAt)}</dd>
              <dt className="text-muted-foreground">Affected ids</dt>
              <dd className="font-mono text-xs">{proposal.affectedIds.join(', ') || '—'}</dd>
              <dt className="text-muted-foreground">Stale</dt>
              <dd className="font-mono text-xs">{proposal.stale ? proposal.staleIds.join(', ') : 'nie'}</dd>
            </dl>
          </TabsContent>
          <TabsContent value="revisions" className="pt-4">
            <p className="text-xs text-faint">
              Rewizje powstają po zatwierdzeniu — ta propozycja jeszcze nie jest zmaterializowana.
            </p>
          </TabsContent>
        </Tabs>
      </div>
      <div ref={actionsRef}>
        <ProposalActions
          onApprove={onApprove}
          onReject={onReject}
          onEdit={onEdit}
          onApproveAsReplacement={onApproveAsReplacement}
          searchSupersedeCandidates={searchSupersedeCandidates}
          stale={proposal.stale}
          staleReason={proposal.stale ? `Zmienione od utworzenia propozycji: ${proposal.staleIds.join(', ')}.` : undefined}
          busy={busy}
          position={position}
        />
      </div>
    </>
  );
}

function ProposalDiff({
  proposal,
  beforeMemory,
  beforeLoading,
  mergeMemories,
  mergeLoading,
}: {
  proposal: ProposalView;
  beforeMemory: MemoryDetail | undefined;
  beforeLoading: boolean;
  mergeMemories: MemoryDetail[];
  mergeLoading: boolean;
}) {
  const effective = proposal.editedPayload ?? proposal.payload;

  if (proposal.type === 'create') {
    return <DiffView type="create" data={{ kind: effective.kind ?? 'fact', header: effective.header ?? '', body: effective.body ?? '' }} />;
  }

  if (proposal.type === 'update') {
    if (beforeLoading || !beforeMemory) return <Skeleton className="h-40 w-full" />;
    return (
      <DiffView
        type="update"
        data={{
          before: { header: beforeMemory.header, body: beforeMemory.body },
          after: { header: effective.header ?? beforeMemory.header, body: effective.body ?? beforeMemory.body },
        }}
      />
    );
  }

  if (proposal.type === 'merge') {
    if (mergeLoading || mergeMemories.length === 0) return <Skeleton className="h-40 w-full" />;
    return (
      <DiffView
        type="merge"
        data={{
          sources: mergeMemories.map((m) => ({ id: m.id, header: m.header })),
          result: { header: effective.header ?? '', body: effective.body ?? '' },
        }}
      />
    );
  }

  if (beforeLoading || !beforeMemory) return <Skeleton className="h-40 w-full" />;
  return (
    <DiffView
      type="delete"
      data={{ memoryId: effective.memoryId ?? beforeMemory.id, header: beforeMemory.header, body: beforeMemory.body }}
    />
  );
}

function EditProposalForm({
  initialHeader,
  initialBody,
  initialTags,
  onCancel,
  onSave,
  saving,
}: {
  initialHeader: string;
  initialBody: string;
  initialTags: string[];
  onCancel: () => void;
  onSave: (vars: { header: string; body: string; tags: string[] }) => void;
  saving: boolean;
}) {
  const [header, setHeader] = useState(initialHeader);
  const [body, setBody] = useState(initialBody);
  const [tagsInput, setTagsInput] = useState(initialTags.join(', '));

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
        Nagłówek
        <Input value={header} onChange={(e) => setHeader(e.target.value)} maxLength={200} />
      </label>
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
        Treść
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} />
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
          disabled={saving}
          onClick={() =>
            onSave({
              header,
              body,
              tags: tagsInput
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        >
          {saving ? 'Zapisywanie…' : 'Zapisz'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Krawędzie attach-on-save (roadmap v1.2, "memory-relations + 1-hop graph boost") niesione w
 * `payload.relations` (FINDING 1 review PR #15) — materializują się DOPIERO w `ProposalsService.approve()`,
 * ale recenzent musi je widzieć PRZED kliknięciem "Zatwierdź" (human-gate integrity: bez tego widzi
 * treść pamięci, ale nie widzi, że approve dorzuci do 16 krawędzi grafu). Renderowane z payloadu, który
 * faktycznie pójdzie do approve (`effective` = `editedPayload ?? payload` w wywołaniu wyżej) — edycja
 * treści (`EditProposalForm`) nigdy nie dotyka `relations` (serwer je kopiuje 1:1, patrz `ProposalsService.edit`).
 *
 * Wizualnie mirror `RelationRow` w `RelationsPanel.tsx` (ten sam PR) — `ArrowUpRight` (attach-on-save
 * jest zawsze wychodząca: fromId = ta pamięć, targetId = istniejąca) + `Badge variant="kind"` na
 * typie relacji — ale czysto read-only: bez usuwania/nawigacji (Queue nie ma przejścia do przeglądarki
 * pamięci). Nagłówek targetu dociągnięty tanio (istniejący `GET /memories/:id`, `useProposalDetailData`
 * wyżej w tym pliku) — gdy niedostępny (target zniknął / jeszcze się ładuje), pokazujemy sam `targetId`.
 */
function ProposalRelations({
  relations,
  headers,
}: {
  relations: { type: RelationType; targetId: string }[];
  headers: Map<string, string>;
}) {
  return (
    <div className="mb-4 flex flex-col gap-1.5 border-b border-border pb-4">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.04em] text-faint">
        Krawędzie po zatwierdzeniu ({relations.length})
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {relations.map((rel, i) => {
          const header = headers.get(rel.targetId);
          return (
            <li key={`${rel.type}-${rel.targetId}-${i}`} className="flex min-w-0 items-center gap-2 text-[13px]">
              <ArrowUpRight className="size-3.5 shrink-0 text-faint" aria-label="wychodząca" />
              <Badge variant="kind" className="shrink-0">
                {rel.type}
              </Badge>
              {header ? <span className="min-w-0 flex-1 truncate text-foreground">{header}</span> : <span className="flex-1" />}
              <MonoId value={rel.targetId} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Dot() {
  return <span className="size-[3px] rounded-full bg-border-strong" aria-hidden />;
}
