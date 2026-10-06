import { KeyRound } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { TokenManager } from '../components/TokenManager';
import type { ProjectListItem } from '../types/api';

export interface ProjectTokensDialogProps {
  project: ProjectListItem | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog "Tokeny" (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") — sibling
 * `ProjectSettingsDialog.tsx`: lista tokenów projektu + tworzenie/rotacja/unieważnienie/rename (cała
 * logika w `TokenManager`, współdzielonym z sekcją "Tokeny konta", roadmap v1.5). Treść montowana TYLKO
 * gdy `project !== null` (wzór `PurgeMemoryDialog`/`HumanCreateDialog` — zamknięcie odmontowuje,
 * kolejne otwarcie dostaje świeży `useState`/`useQuery`).
 */
export function ProjectTokensDialog({ project, onOpenChange }: ProjectTokensDialogProps) {
  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent className="w-[min(920px,calc(100vw-40px))] max-h-[85vh] overflow-y-auto">
        {project && (
          <>
            <DialogHeader>
              <KeyRound className="size-[19px] text-primary" />
              <DialogTitle>Tokeny — {project.name}</DialogTitle>
            </DialogHeader>
            <TokenManager scope={{ kind: 'project', projectId: project.id }} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
