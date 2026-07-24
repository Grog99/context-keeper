import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { DedupHint } from '../components/DedupHint';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { toDatetimeLocalValue } from '../lib/format';
import { queryKeys } from '../lib/query';
import type { DashboardLimits, HumanCreateResponse, MemoryListItem } from '../types/api';
import type { MemoryKind, MemoryScope } from '../types/domain';

const KINDS: { value: MemoryKind; label: string }[] = [
  { value: 'fact', label: 'Fakt' },
  { value: 'document', label: 'Dokument' },
  { value: 'event', label: 'Zdarzenie' },
];

const DEFAULT_LIMITS: DashboardLimits = {
  headerMaxLen: 200,
  bodyMaxFact: 8192,
  bodyMaxDocument: 262144,
  bodyMaxEvent: 8192,
  tagsMax: 10,
  tagMaxLen: 40,
  mcpPublicUrl: null,
};

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function deriveHeaderFromFilename(filename: string): string {
  return filename
    .replace(/\.mdx?$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

export interface HumanCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: MemoryScope;
  projectId?: string;
  projectName?: string;
}

/**
 * §9.5 design-systemu — Dialog "Nowa pamięć". Cienki wrapper: cały formularz żyje w
 * `HumanCreateForm`, montowanym TYLKO gdy `open` (zamiast reset-efektu przy zamknięciu) — zamknięcie
 * odmontowuje formularz, kolejne otwarcie dostaje świeży `useState` za darmo (React Compiler
 * eslint zabrania `setState` bezpośrednio w efekcie do resetowania stanu, §react-hooks/set-state-in-effect).
 */
export function HumanCreateDialog({ open, onOpenChange, scope, projectId, projectName }: HumanCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto">
        {open && (
          <HumanCreateForm onOpenChange={onOpenChange} scope={scope} projectId={projectId} projectName={projectName} />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface HumanCreateFormProps {
  onOpenChange: (open: boolean) => void;
  scope: MemoryScope;
  projectId?: string;
  projectName?: string;
}

function HumanCreateForm({ onOpenChange, scope, projectId, projectName }: HumanCreateFormProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<MemoryKind>('fact');
  const [header, setHeader] = useState('');
  const [body, setBody] = useState('');
  const [eventTime, setEventTime] = useState(() => toDatetimeLocalValue(new Date()));
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [importTab, setImportTab] = useState<'paste' | 'upload'>('paste');
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [similarIds, setSimilarIds] = useState<string[]>([]);

  const { data: limits = DEFAULT_LIMITS } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: () => api.get<DashboardLimits>('/config'),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    const q = header.trim().split(/\s+/).slice(0, 6).join(' ');
    const handle = setTimeout(() => {
      if (q.length < 4) {
        setSimilarIds([]);
        return;
      }
      const params = new URLSearchParams({ q, status: 'approved' });
      if (scope === 'project' && projectId) {
        params.set('scope', 'project');
        params.set('projectId', projectId);
      } else if (scope === 'global') {
        params.set('scope', 'global');
      }
      api
        .get<MemoryListItem[]>(`/memories?${params.toString()}`)
        .then((found) => setSimilarIds(found.slice(0, 3).map((m) => m.id)))
        .catch(() => setSimilarIds([]));
    }, 500);
    return () => clearTimeout(handle);
  }, [header, scope, projectId]);

  const bodyCap = kind === 'fact' ? limits.bodyMaxFact : kind === 'event' ? limits.bodyMaxEvent : limits.bodyMaxDocument;
  const bodyBytes = utf8Bytes(body);
  const headerOverLimit = header.length > limits.headerMaxLen;
  const bodyOverLimit = bodyBytes > bodyCap;
  const eventTimeInvalid = kind === 'event' && Number.isNaN(new Date(eventTime).getTime());
  const canSave =
    header.trim().length > 0 && body.trim().length > 0 && !headerOverLimit && !bodyOverLimit && !eventTimeInvalid;

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<HumanCreateResponse>('/memories', {
        kind,
        header: header.trim(),
        body,
        tags: commitTagDraft(tagDraft, tags),
        scope,
        projectId: scope === 'project' ? projectId : undefined,
        eventTime: kind === 'event' ? new Date(eventTime).toISOString() : undefined,
      }),
    onSuccess: (result) => {
      toast.success('Utworzono');
      for (const warning of result.warnings) toast.warning(warning);
      queryClient.invalidateQueries({ queryKey: ['memories'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.metrics() });
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  function commitTagDraft(draft: string, current: string[]): string[] {
    const normalized = draft.trim().toLowerCase();
    if (!normalized || current.includes(normalized)) return current;
    return [...current, normalized];
  }

  function addTagFromDraft(): void {
    const next = commitTagDraft(tagDraft, tags);
    if (next !== tags) setTags(next);
    setTagDraft('');
  }

  function handleTagKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTagFromDraft();
    } else if (event.key === 'Backspace' && tagDraft.length === 0 && tags.length > 0) {
      setTags(tags.slice(0, -1));
    }
  }

  function removeTag(tag: string): void {
    setTags(tags.filter((t) => t !== tag));
  }

  function loadFile(file: File): void {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      setBody(content);
      if (!header.trim()) {
        const headingMatch = content.match(/^#\s+(.+)$/m);
        setHeader(headingMatch ? headingMatch[1].trim() : deriveHeaderFromFilename(file.name));
      }
    };
    reader.readAsText(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file) loadFile(file);
  }

  const scopeLabel = scope === 'global' ? 'global' : (projectName ?? projectId ?? 'projekt');

  return (
    <>
      <DialogHeader>
        <DialogTitle>Nowa pamięć</DialogTitle>
      </DialogHeader>
      <DialogDescription>
        Commit bezpośredni (bez kolejki) w kontekście <span className="font-mono text-foreground">{scopeLabel}</span>.
      </DialogDescription>

      <div className="flex flex-col gap-4">
        <div className="flex gap-1.5">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              onClick={() => setKind(k.value)}
              className={
                'h-8 flex-1 rounded-md border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
                (kind === k.value
                  ? 'border-primary bg-accent-subtle text-foreground'
                  : 'border-border-strong bg-background text-muted-foreground hover:bg-muted')
              }
            >
              {k.label}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="flex items-center justify-between text-xs font-medium text-muted-foreground">
            Nagłówek
            <span className={headerOverLimit ? 'font-mono text-danger' : 'font-mono text-faint'}>
              {header.length} / {limits.headerMaxLen}
            </span>
          </span>
          <Input value={header} onChange={(e) => setHeader(e.target.value)} autoFocus />
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

        <Tabs value={importTab} onValueChange={(v) => setImportTab(v as 'paste' | 'upload')}>
          <TabsList>
            <TabsTrigger value="paste">Wklej</TabsTrigger>
            <TabsTrigger value="upload">Wgraj .md</TabsTrigger>
          </TabsList>
          <TabsContent value="paste" className="pt-3">
            <label className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                Treść
                <span className={bodyOverLimit ? 'font-mono text-danger' : 'font-mono text-faint'}>
                  {bodyBytes} / {bodyCap} B
                </span>
              </span>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={kind === 'document' ? 12 : 6} />
            </label>
          </TabsContent>
          <TabsContent value="upload" className="pt-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground transition-colors ' +
                (dragActive ? 'border-primary bg-accent-subtle' : 'border-border-strong hover:bg-muted')
              }
            >
              <FileUp className="size-5 text-faint" />
              {fileName ? (
                <span className="font-mono text-foreground">{fileName}</span>
              ) : (
                <span>Przeciągnij plik .md tutaj albo kliknij, żeby wybrać</span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,text/markdown,text/plain"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) loadFile(file);
                }}
              />
            </div>
            {body.length > 0 && (
              <p className="mt-2 font-mono text-2xs text-faint">
                Wczytano {utf8Bytes(body)} B — edytowalne w zakładce "Wklej".
              </p>
            )}
          </TabsContent>
        </Tabs>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Tagi</span>
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-[4px] border border-border bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
              >
                {tag}
                <button type="button" onClick={() => removeTag(tag)} aria-label={`Usuń tag ${tag}`}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={handleTagKeyDown}
              onBlur={addTagFromDraft}
              placeholder={tags.length === 0 ? 'np. infra, database' : ''}
              className="min-w-[80px] flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </div>
        </label>

        <DedupHint similarIds={similarIds} />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={createMutation.isPending}>
            Anuluj
          </Button>
          <Button variant="primary" disabled={!canSave || createMutation.isPending} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? 'Zapisywanie…' : 'Utwórz'}
          </Button>
        </div>
      </div>
    </>
  );
}
