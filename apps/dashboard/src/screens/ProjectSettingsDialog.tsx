import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Switch } from '../components/ui/switch';
import { MonoId } from '../components/MonoId';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { formatAbsoluteTime } from '../lib/format';
import { queryKeys } from '../lib/query';
import type { ProjectListItem } from '../types/api';

export interface ProjectSettingsDialogProps {
  project: ProjectListItem | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * §9.3 design-systemu — dialog szczegółów projektu, otwierany z ikony ⚙ w wierszu `ProjectsScreen`
 * (nie inline switch w tabeli — user, wariant B z otwartego pytania plannera). Jedyne dziś edytowalne
 * pole: `includeEventsInDefaultSearch` (roadmap v1.2, "kind=event episodic") — czy `event` dokłada
 * się do domyślnego `kind` w `search_memory` agenta. Zmiana leci przez `PATCH /api/projects/:id`,
 * backend audytuje ją jako `project_settings_changed` (widoczne na ekranie "Audyt" bez dodatkowej
 * pracy tutaj).
 */
export function ProjectSettingsDialog({ project, onOpenChange }: ProjectSettingsDialogProps) {
  const queryClient = useQueryClient();

  const toggleMutation = useMutation({
    mutationFn: (vars: { id: string; includeEventsInDefaultSearch: boolean }) =>
      api.patch<ProjectListItem>(`/projects/${vars.id}`, {
        includeEventsInDefaultSearch: vars.includeEventsInDefaultSearch,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent className="max-w-md">
        {project && (
          <>
            <DialogHeader>
              <DialogTitle>Ustawienia projektu „{project.name}"</DialogTitle>
            </DialogHeader>

            <dl className="mb-5 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
              <dt className="text-muted-foreground">project_id</dt>
              <dd>
                <MonoId value={project.id} />
              </dd>
              <dt className="text-muted-foreground">Pamięci</dt>
              <dd className="font-mono text-xs tabular-nums">{project.memoryCount}</dd>
              <dt className="text-muted-foreground">Utworzono</dt>
              <dd className="font-mono text-xs">{formatAbsoluteTime(project.createdAt)}</dd>
            </dl>

            <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-muted/40 px-3.5 py-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-[13.5px] font-medium text-foreground">
                  Dołączaj zdarzenia do domyślnego wyszukiwania
                </span>
                <span className="text-xs text-muted-foreground">
                  Gdy włączone, <span className="font-mono text-2xs">search_memory</span> bez jawnego{' '}
                  <span className="font-mono text-2xs">kind</span> dołącza też{' '}
                  <span className="font-mono text-2xs">event</span> obok fact/document dla tego projektu.
                  Agent może zawsze poprosić o <span className="font-mono text-2xs">kind=event</span> jawnie,
                  niezależnie od tego ustawienia.
                </span>
              </div>
              <Switch
                checked={project.includeEventsInDefaultSearch}
                disabled={toggleMutation.isPending}
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({ id: project.id, includeEventsInDefaultSearch: checked })
                }
                aria-label="Dołączaj zdarzenia do domyślnego wyszukiwania"
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
