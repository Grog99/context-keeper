import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, KeyRound, Plus } from 'lucide-react';
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
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { EmptyState } from '../components/EmptyState';
import { MonoId } from '../components/MonoId';
import { TokenReveal } from '../components/TokenReveal';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { queryKeys } from '../lib/query';
import type { CreatedProject, ProjectListItem } from '../types/api';

function tokenStatusBadge(status: ProjectListItem['tokenStatus']) {
  if (status === 'active') return <Badge variant="success">aktywny</Badge>;
  if (status === 'rotated') return <Badge variant="pending">rotowany</Badge>;
  return <Badge variant="neutral">brak tokena</Badge>;
}

/** §9.3 design-systemu — poza ContextSwitcherem (widzi WSZYSTKIE projekty, §9.3: "Ten ekran ignoruje
 * ContextSwitcher"). CRUD projektów + generacja/rotacja tokenów; `TokenReveal` po każdej akcji. */
export function ProjectsScreen() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [rotateTarget, setRotateTarget] = useState<ProjectListItem | null>(null);
  const [reveal, setReveal] = useState<{ token: string; reason: 'created' | 'rotated' } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectListItem[]>('/projects'),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => api.post<CreatedProject>('/projects', { name }),
    onSuccess: (result) => {
      setCreateOpen(false);
      setNewName('');
      setReveal({ token: result.token, reason: 'created' });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => api.post<CreatedProject>(`/projects/${id}/rotate-token`),
    onSuccess: (result) => {
      setRotateTarget(null);
      setReveal({ token: result.token, reason: 'rotated' });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const projects = data ?? [];

  return (
    <div className="overflow-y-auto p-6">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Projekty i tokeny</h1>
      <p className="mb-5 max-w-2xl text-[13.5px] text-muted-foreground">
        CRUD projektów oraz generacja/rotacja bearer tokenów <span className="font-mono">ck_…</span>. Ten ekran żyje
        poza przełącznikiem kontekstu — widzi wszystkie projekty.
      </p>

      {isLoading ? (
        <Skeleton className="h-48 w-full max-w-4xl" />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={Folder}
          title="Brak projektów"
          description="Utwórz pierwszy projekt, żeby wydać token dla agenta."
          action={
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> Nowy projekt
            </Button>
          }
        />
      ) : (
        <div className="max-w-4xl overflow-hidden rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                <Th>Projekt</Th>
                <Th>project_id</Th>
                <Th>Pamięci</Th>
                <Th>Token</Th>
                <th className="px-3.5 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">
                  Akcje
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id} className="border-b border-border last:border-b-0">
                  <td className="px-3.5 py-2.5 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <Folder className="size-3.5 text-faint" />
                      {project.name}
                    </span>
                  </td>
                  <td className="px-3.5 py-2.5">
                    <MonoId value={project.id} />
                  </td>
                  <td className="px-3.5 py-2.5 font-mono tabular-nums">{project.memoryCount}</td>
                  <td className="px-3.5 py-2.5">{tokenStatusBadge(project.tokenStatus)}</td>
                  <td className="px-3.5 py-2.5 text-right">
                    <Button variant="secondary" size="sm" onClick={() => setRotateTarget(project)}>
                      <KeyRound className="size-3.5" /> Rotuj token
                    </Button>
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={5} className="px-3.5 py-3 text-center">
                  <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="size-4" /> Nowy projekt
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          {createOpen && (
            <>
              <DialogHeader>
                <DialogTitle>Nowy projekt</DialogTitle>
              </DialogHeader>
              <label className="mb-4 flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Nazwa
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus placeholder="np. acme" />
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setCreateOpen(false)}>
                  Anuluj
                </Button>
                <Button
                  variant="primary"
                  disabled={newName.trim().length === 0 || createMutation.isPending}
                  onClick={() => createMutation.mutate(newName.trim())}
                >
                  {createMutation.isPending ? 'Tworzenie…' : 'Utwórz'}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={rotateTarget !== null} onOpenChange={(open) => !open && setRotateTarget(null)}>
        <AlertDialogContent>
          {rotateTarget && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Rotować token projektu „{rotateTarget.name}"?</AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogDescription>
                Stary token przestanie działać natychmiast (hard-cutover) — zaktualizuj konfigurację klientów MCP
                zaraz po rotacji.
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>Anuluj</AlertDialogCancel>
                <AlertDialogAction onClick={() => rotateMutation.mutate(rotateTarget.id)} disabled={rotateMutation.isPending}>
                  Rotuj token
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {reveal && (
        <TokenReveal
          open={reveal !== null}
          onOpenChange={(open) => !open && setReveal(null)}
          token={reveal.token}
          reason={reveal.reason}
        />
      )}
    </div>
  );
}

function Th({ children }: { children: string }) {
  return <th className="px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">{children}</th>;
}
