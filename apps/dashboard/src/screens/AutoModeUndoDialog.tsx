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
import { Checkbox } from '../components/ui/checkbox';
import { Skeleton } from '../components/ui/skeleton';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { formatAbsoluteTime } from '../lib/format';
import { queryKeys } from '../lib/query';
import { toQueryString } from '../lib/query-string';
import type { AutoUndoPreview, AutoUndoResult, ProjectListItem } from '../types/api';

/** Zawężenia filtra cofania w formie, w jakiej jadą do serwera (ISO / opaque id) — ten sam kształt, z którego
 * przeglądarka liczy `Archiwizuj pasujące (N)`. */
export interface AutoUndoFilterParams {
  from?: string;
  to?: string;
  tokenId?: string;
}

export interface AutoModeUndoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectListItem;
  filter: AutoUndoFilterParams;
  /** Etykieta tokena do opisu zakresu (id tokena nic nie mówi człowiekowi). */
  tokenLabel?: string;
}

/** Przedział do opisu w dialogu: „od … do …", jednostronnie „od …" / „do …", brak = „cały czas". */
function describeRange(filter: AutoUndoFilterParams): string {
  if (filter.from && filter.to) return `${formatAbsoluteTime(filter.from)} – ${formatAbsoluteTime(filter.to)}`;
  if (filter.from) return `od ${formatAbsoluteTime(filter.from)}`;
  if (filter.to) return `do ${formatAbsoluteTime(filter.to)}`;
  return 'cały czas';
}

/**
 * Masowe cofanie auto mode (roadmap v1.6, A3) — `AlertDialog` z liczbami Z SERWERA (nie z długości listy, która
 * ma twardy limit): N wpisów utworzonych przez auto mode do archiwizacji i M pominiętych auto-korekt. Wykonanie
 * archiwizuje dokładnie `ids` z podglądu (wpisy zapisane po otwarciu okna nie wejdą). Treść montowana TYLKO gdy
 * `open` (wzór `PurgeMemoryDialog`) — każde otwarcie ma świeży podgląd i świeży stan checkboxa.
 */
export function AutoModeUndoDialog(props: AutoModeUndoDialogProps) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>{props.open && <AutoModeUndoForm {...props} />}</AlertDialogContent>
    </AlertDialog>
  );
}

function AutoModeUndoForm({ onOpenChange, project, filter, tokenLabel }: AutoModeUndoDialogProps) {
  const queryClient = useQueryClient();
  // Checkbox domyślnie zaznaczony, gdy auto mode jest włączony (G3) — ukryty, gdy wyłączony.
  const [disableAutoMode, setDisableAutoMode] = useState(true);

  const previewParams = { projectId: project.id, ...filter };
  const {
    data: preview,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: [...queryKeys.autoUndoPreview(previewParams), 'dialog'],
    queryFn: () => api.get<AutoUndoPreview>(`/memories/auto-undo/preview${toQueryString(previewParams)}`),
    // Zawsze świeże liczby — podgląd w dialogu to podstawa decyzji o masowej, nieodwracalnej akcji.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const undoMutation = useMutation({
    mutationFn: async (p: AutoUndoPreview): Promise<{ result: AutoUndoResult; autoModeDisabled: boolean }> => {
      const turnOff = project.autoMode && disableAutoMode;
      // Najpierw wyłączenie auto mode (istniejąca ścieżka z audytem `project_settings_changed`): jeśli się nie
      // uda, nic nie jest archiwizowane; jeśli archiwizacja padnie później, auto mode zostaje wyłączony (bezpieczny
      // kierunek) i ponowienie jest bezpieczne.
      if (turnOff) await api.patch(`/projects/${project.id}`, { autoMode: false });
      const result = await api.post<AutoUndoResult>('/memories/auto-undo/execute', {
        projectId: project.id,
        ids: p.ids,
      });
      return { result, autoModeDisabled: turnOff };
    },
    onSuccess: ({ result, autoModeDisabled }) => {
      const parts = [`Zarchiwizowano ${result.archived} wpisów z auto mode`];
      if (result.skipped > 0) parts.push(`${result.skipped} pominięto (zmienione od podglądu)`);
      if (autoModeDisabled) parts.push('auto mode wyłączony');
      toast.success(parts.join(' · '));
      queryClient.invalidateQueries({ queryKey: ['memories'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      queryClient.invalidateQueries({ queryKey: ['audit'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.metrics() });
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(describeApiError(err));
      // Wyłączenie auto mode mogło się udać mimo błędu archiwizacji — odśwież przełącznik.
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
  });

  const count = preview?.ids.length ?? 0;

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Archiwizować wpisy z auto mode?</AlertDialogTitle>
      </AlertDialogHeader>
      <AlertDialogDescription>
        Projekt <span className="font-mono text-foreground">{project.name}</span> · auto-zaakceptowane{' '}
        {describeRange(filter)}
        {tokenLabel ? (
          <>
            {' '}
            · token <span className="font-mono text-foreground">{tokenLabel}</span>
          </>
        ) : null}
        .{preview ? ` Stan na ${formatAbsoluteTime(preview.asOf)}.` : ''}
      </AlertDialogDescription>

      {isLoading ? (
        <Skeleton className="mb-4 h-20 w-full" />
      ) : isError || !preview ? (
        <p className="mb-4 text-sm text-danger" role="alert">
          {describeApiError(error)}
        </p>
      ) : (
        <>
          <dl className="mb-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs">
            <dt className="text-muted-foreground">Do archiwizacji (utworzone przez auto mode)</dt>
            <dd className="font-mono tabular-nums text-foreground">{preview.archivable}</dd>
            <dt className="text-muted-foreground">Pominięte — auto-korekty istniejących pamięci</dt>
            <dd className="font-mono tabular-nums text-foreground">{preview.skippedCorrections}</dd>
          </dl>
          {preview.skippedCorrections > 0 && (
            <p className="mb-3 text-xs text-muted-foreground">
              Bieżąca treść pochodzi z auto-korekty pamięci, którą utworzył lub zatwierdził człowiek. Cofanie ich
              nie archiwizuje — przejrzyj je ręcznie (znacznik „auto · korekta" na liście).
            </p>
          )}
          {preview.capped && (
            <p
              className="mb-3 rounded-md border border-warning bg-warning-subtle px-3 py-2 text-xs text-warning-foreground"
              role="status"
            >
              Jednorazowo archiwizowanych jest najwyżej {preview.ids.length} najstarszych z {preview.archivable}{' '}
              wpisów — po zakończeniu uruchom cofanie ponownie.
            </p>
          )}
          {count === 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">
              Nic do zarchiwizowania — pasujące wpisy to wyłącznie auto-korekty.
            </p>
          ) : (
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Archiwizacja to soft-delete: wpisy znikają z wyszukiwania, tracą embeddingi i relacje (każda usunięta
              relacja trafia do audytu). Treść zostaje w bazie i w historii rewizji, ale dashboard nie ma ścieżki
              przywrócenia zarchiwizowanej pamięci. Wpisy zapisane po otwarciu tego okna nie zostaną
              zarchiwizowane.
            </p>
          )}
        </>
      )}

      {project.autoMode && (
        <label className="mb-4 flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5">
          <Checkbox
            checked={disableAutoMode}
            onCheckedChange={(checked) => setDisableAutoMode(checked === true)}
            disabled={undoMutation.isPending}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium text-foreground">Wyłącz też auto mode w projekcie</span>
            <span className="text-xs text-muted-foreground">
              Kolejne zapisy agenta trafią do kolejki. Możesz go ponownie włączyć w ustawieniach projektu.
            </span>
          </span>
        </label>
      )}

      <AlertDialogFooter>
        <AlertDialogCancel disabled={undoMutation.isPending}>Anuluj</AlertDialogCancel>
        <AlertDialogAction
          // Bez `preventDefault` Radix zamknąłby dialog od razu po kliknięciu — a on ma zostać otwarty do końca
          // mutacji (błąd PATCH/archiwizacji musi być widoczny, ponowienie bezpieczne). Zamyka go `onSuccess`.
          onClick={(e) => {
            e.preventDefault();
            if (preview && count > 0) undoMutation.mutate(preview);
          }}
          disabled={!preview || count === 0 || undoMutation.isPending}
        >
          {undoMutation.isPending ? 'Archiwizowanie…' : `Archiwizuj ${count}`}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
