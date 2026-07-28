import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, KeyRound, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { EmptyState } from '../components/EmptyState';
import { MonoId } from '../components/MonoId';
import { ScreenContainer } from '../components/ScreenContainer';
import { TokenReveal } from '../components/TokenReveal';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { queryKeys } from '../lib/query';
import type { CreatedProject, ProjectListItem, TokenCounts } from '../types/api';
import { ProjectSettingsDialog } from './ProjectSettingsDialog';
import { ProjectTokensDialog } from './ProjectTokensDialog';

const DEFAULT_TOKEN_LABEL = 'default';

/** Badge liczników tokenów (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") —
 * zastępuje dawny 1:1 `tokenStatusBadge` (jeden token = jeden status). `revoked` pominięty (nic
 * operacyjnie interesującego w podglądzie listy — pełny obraz jest w `ProjectTokensDialog`). */
function tokenCountsBadge(counts: TokenCounts) {
  if (counts.active === 0 && counts.grace === 0) {
    return <Badge variant="neutral">brak aktywnych</Badge>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {counts.active > 0 && <Badge variant="success">{counts.active} aktywne</Badge>}
      {counts.grace > 0 && <Badge variant="pending">{counts.grace} karencja</Badge>}
    </span>
  );
}

/** §9.3 design-systemu — poza ContextSwitcherem (widzi WSZYSTKIE projekty, §9.3: "Ten ekran ignoruje
 * ContextSwitcher"). CRUD projektów + zarządzanie tokenami (roadmap v1.3 — wiele tokenów per
 * projekt, graceful rotation przez `ProjectTokensDialog`); `TokenReveal` po utworzeniu projektu. */
export function ProjectsScreen() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTokenLabel, setNewTokenLabel] = useState(DEFAULT_TOKEN_LABEL);
  const [reveal, setReveal] = useState<{ token: string; label: string; reason: 'created' } | null>(null);
  // Id, nie snapshot obiektu — po mutacji invaliduje `queryKeys.projects()`, dialog musi pokazać
  // ŚWIEŻĄ wartość z refetchowanej listy, nie stan sprzed mutacji.
  const [settingsTargetId, setSettingsTargetId] = useState<string | null>(null);
  const [tokensTargetId, setTokensTargetId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectListItem[]>('/projects'),
  });

  const createMutation = useMutation({
    mutationFn: (vars: { name: string; tokenLabel: string }) =>
      api.post<CreatedProject>('/projects', { name: vars.name, tokenLabel: vars.tokenLabel }),
    onSuccess: (result) => {
      setCreateOpen(false);
      setNewName('');
      setNewTokenLabel(DEFAULT_TOKEN_LABEL);
      setReveal({ token: result.token, label: result.tokenRow.label, reason: 'created' });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  const projects = data ?? [];
  const settingsTarget = projects.find((p) => p.id === settingsTargetId) ?? null;
  const tokensTarget = projects.find((p) => p.id === tokensTargetId) ?? null;

  return (
    <ScreenContainer width="wide">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Projekty i tokeny</h1>
      <p className="mb-5 max-w-2xl text-[13.5px] text-muted-foreground">
        CRUD projektów oraz zarządzanie bearer tokenami <span className="font-mono">ck_…</span> — wiele tokenów per
        projekt (jeden na agenta), graceful rotation (nowy token obok starego, stary wygasa po okresie karencji) i
        natychmiastowe unieważnienie. Ten ekran żyje poza przełącznikiem kontekstu — widzi wszystkie projekty.
      </p>

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
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
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                <Th>Projekt</Th>
                <Th>project_id</Th>
                <Th>Pamięci</Th>
                <Th>Tokeny</Th>
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
                  <td className="px-3.5 py-2.5">{tokenCountsBadge(project.tokenCounts)}</td>
                  <td className="px-3.5 py-2.5 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setSettingsTargetId(project.id)}
                        aria-label={`Ustawienia projektu ${project.name}`}
                      >
                        <Settings className="size-3.5" />
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setTokensTargetId(project.id)}>
                        <KeyRound className="size-3.5" /> Tokeny
                      </Button>
                    </span>
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
              <label className="mb-4 flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Etykieta pierwszego tokena
                <Input
                  value={newTokenLabel}
                  onChange={(e) => setNewTokenLabel(e.target.value)}
                  placeholder={DEFAULT_TOKEN_LABEL}
                  maxLength={40}
                />
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setCreateOpen(false)}>
                  Anuluj
                </Button>
                <Button
                  variant="primary"
                  disabled={newName.trim().length === 0 || newTokenLabel.trim().length === 0 || createMutation.isPending}
                  onClick={() => createMutation.mutate({ name: newName.trim(), tokenLabel: newTokenLabel.trim() })}
                >
                  {createMutation.isPending ? 'Tworzenie…' : 'Utwórz'}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {reveal && (
        <TokenReveal
          open={reveal !== null}
          onOpenChange={(open) => !open && setReveal(null)}
          token={reveal.token}
          label={reveal.label}
          reason={reveal.reason}
        />
      )}

      <ProjectSettingsDialog project={settingsTarget} onOpenChange={(open) => !open && setSettingsTargetId(null)} />
      <ProjectTokensDialog project={tokensTarget} onOpenChange={(open) => !open && setTokensTargetId(null)} />
    </ScreenContainer>
  );
}

function Th({ children }: { children: string }) {
  return <th className="px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">{children}</th>;
}
