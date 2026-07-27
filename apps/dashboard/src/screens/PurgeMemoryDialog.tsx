import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { Skeleton } from '../components/ui/skeleton';
import { Textarea } from '../components/ui/textarea';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { queryKeys } from '../lib/query';
import type { PurgePreview, PurgeResult } from '../types/api';

export interface PurgeMemoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memoryId: string;
  memoryHeader: string;
}

/**
 * Hard-purge z dashboardu (roadmap v1.1, plan §2 krok 7) — dry-run → confirm+reason, jak `purge`
 * CLI. `AlertDialog` (destructive/irreversible primitive, jak Archiwizuj/Odrzuć), treść montowana
 * TYLKO gdy `open` (wzór `HumanCreateDialog` — zamknięcie odmontowuje, kolejne otwarcie dostaje
 * świeży `useState`/`useQuery`, bez efektu resetującego).
 */
export function PurgeMemoryDialog({ open, onOpenChange, memoryId, memoryHeader }: PurgeMemoryDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {open && (
          <PurgeMemoryForm onOpenChange={onOpenChange} memoryId={memoryId} memoryHeader={memoryHeader} />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface PurgeMemoryFormProps {
  onOpenChange: (open: boolean) => void;
  memoryId: string;
  memoryHeader: string;
}

function PurgeMemoryForm({ onOpenChange, memoryId, memoryHeader }: PurgeMemoryFormProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const { data: preview, isLoading } = useQuery({
    queryKey: queryKeys.memoryPurgePreview(memoryId),
    queryFn: () => api.get<PurgePreview>(`/memories/${memoryId}/purge-preview`),
  });

  const purgeMutation = useMutation({
    mutationFn: () => api.post<PurgeResult>(`/memories/${memoryId}/purge`, { reason }),
    onSuccess: (result) => {
      toast.success(
        `Wymazano — embeddingi: ${result.embeddingsDeleted}, propozycje: ${result.proposalsRedacted}, ` +
          `rewizje: ${result.revisionsRedacted}, relacje: ${result.relationsDeleted}`,
      );
      queryClient.invalidateQueries({ queryKey: ['memories'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.memory(memoryId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.memoryRevisions(memoryId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.metrics() });
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Hard-purge — nieodwracalne</AlertDialogTitle>
      </AlertDialogHeader>
      <AlertDialogDescription>
        Pamięć <span className="font-mono text-foreground">{memoryHeader}</span> zostanie trwale wymazana:
        treść i tagi znikają, embeddingi są usuwane, a powiązane propozycje i rewizje zredagowane. Soft-delete
        (Archiwizuj) da się odwrócić — to nie.
      </AlertDialogDescription>

      {isLoading ? (
        <Skeleton className="mb-4 h-16 w-full" />
      ) : preview ? (
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs">
          <dt className="text-muted-foreground">Embeddingi</dt>
          <dd className="font-mono">{preview.embeddingsCount}</dd>
          <dt className="text-muted-foreground">Powiązane propozycje</dt>
          <dd className="font-mono">{preview.relatedProposalsCount}</dd>
          <dt className="text-muted-foreground">Rewizje z treścią</dt>
          <dd className="font-mono">{preview.revisionsWithContentCount}</dd>
          <dt className="text-muted-foreground">Relacje</dt>
          <dd className="font-mono">{preview.relationsCount}</dd>
        </dl>
      ) : null}

      <label className="mb-4 flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
        Powód (wymagany, trafia do audytu)
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder='np. "AWS access key wyciekł w body, rotacja wykonana"'
          autoFocus
        />
      </label>

      <AlertDialogFooter>
        <AlertDialogCancel disabled={purgeMutation.isPending}>Anuluj</AlertDialogCancel>
        <AlertDialogAction
          onClick={() => purgeMutation.mutate()}
          disabled={!reason.trim() || purgeMutation.isPending}
        >
          {purgeMutation.isPending ? 'Wymazywanie…' : 'Hard-purge'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
