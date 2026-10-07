import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { MonoId } from '../components/MonoId';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { formatAbsoluteTime } from '../lib/format';
import { queryKeys } from '../lib/query';
import type { ProjectListItem } from '../types/api';

// Klient-side mirror reguł slugu (`apps/server/src/projects/slug.ts`: `PROJECT_SLUG_RE`, 2–48 znaków) —
// TYLKO do wyłączenia przycisku "Zapisz"; serwer zostaje authoritative (komunikat błędu zawsze z API).
const PROJECT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROJECT_SLUG_MIN = 2;
const PROJECT_SLUG_MAX = 48;
function normalizeSlugInput(raw: string): string {
  return raw.trim().toLowerCase();
}
function isValidSlug(slug: string): boolean {
  return slug.length >= PROJECT_SLUG_MIN && slug.length <= PROJECT_SLUG_MAX && PROJECT_SLUG_RE.test(slug);
}

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
 * pracy tutaj). Roadmap v1.5: edycja slugu (`SlugRow`) z ostrzeżeniem przed zapisem — repo z dotychczasowym
 * slugiem w `.mcp.json` przestają się rozwiązywać, a ten sam `PATCH` audytuje zmianę (`field: 'slug'`).
 * Roadmap v1.6 (A2): `AutoModeSection` — przełącznik auto mode (włączenie wymaga potwierdzenia w `AlertDialog`,
 * wyłączenie nie) + dzienny limit auto-akceptacji; oba przez ten sam `PATCH`, audytowane jako
 * `project_settings_changed` (`field: 'autoMode'` / `'autoModeDailyLimit'`).
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
              <SlugRow key={project.id} project={project} />
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

            <AutoModeSection key={project.id} project={project} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Wiersz "slug" w `<dl>` ustawień: wartość (kopiowalna) + "Edytuj" → input + "Zapisz"/"Anuluj"; "Zapisz"
 * otwiera `AlertDialog` z ostrzeżeniem, dopiero potwierdzenie wysyła `PATCH`. Montowany z `key={project.id}`,
 * więc stan edycji nie przecieka między projektami. */
function SlugRow({ project }: { project: ProjectListItem }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(project.slug);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const normalized = normalizeSlugInput(value);
  const canSave = isValidSlug(normalized) && normalized !== project.slug;

  const slugMutation = useMutation({
    mutationFn: (slug: string) => api.patch<ProjectListItem>(`/projects/${project.id}`, { slug }),
    onSuccess: () => {
      setConfirmOpen(false);
      setEditing(false);
      toast.success('Slug zmieniony');
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    onError: (err) => {
      setConfirmOpen(false);
      toast.error(describeApiError(err));
    },
  });

  function startEditing() {
    setValue(project.slug);
    setEditing(true);
  }

  return (
    <>
      <dt className="text-muted-foreground">slug</dt>
      <dd>
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              className="h-8 font-mono text-xs"
              maxLength={PROJECT_SLUG_MAX}
              aria-label="Nowy slug"
            />
            <Button variant="primary" size="sm" disabled={!canSave} onClick={() => setConfirmOpen(true)}>
              Zapisz
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Anuluj
            </Button>
          </div>
        ) : (
          <span className="inline-flex items-center gap-2">
            <MonoId value={project.slug} label="slug" />
            <Button variant="secondary" size="sm" onClick={startEditing}>
              Edytuj
            </Button>
          </span>
        )}
      </dd>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !open && !slugMutation.isPending && setConfirmOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Zmienić slug „{project.slug}” → „{normalized}”?
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogDescription>
            Repo z tym slugiem w <span className="font-mono">.mcp.json</span> przestaną się rozwiązywać — agenci
            dostaną <span className="font-mono">project_not_found</span>, dopóki nie zaktualizujesz nagłówka{' '}
            <span className="font-mono">X-Context-Keeper-Project</span> w ich <span className="font-mono">.mcp.json</span>.
            Stary slug nie zostaje aliasem. Zmiana trafia do audytu.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={slugMutation.isPending}>Anuluj</AlertDialogCancel>
            <AlertDialogAction onClick={() => slugMutation.mutate(normalized)} disabled={slugMutation.isPending}>
              {slugMutation.isPending ? 'Zapisywanie…' : 'Zmień slug'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Mirror granic limitu (`AUTO_MODE_MAX_DAILY_LIMIT` na serwerze: CHECK 1..10000) — tylko do wyłączenia przycisku
// "Zapisz"; serwer zostaje authoritative (komunikat błędu zawsze z API).
const AUTO_LIMIT_MIN = 1;
const AUTO_LIMIT_MAX = 10000;

/** Sekcja auto mode (roadmap v1.6, A2, G4/G7). Wyłączenie idzie od razu (zaostrza human-gate, bez tarcia);
 * włączenie otwiera `AlertDialog` (wzorzec `SlugRow`) z opisem, co się zmienia, a co zostaje w kolejce.
 * Limit (okno kroczące 24 h) ma własne pole + "Zapisz". Montowana z `key={project.id}` — stan pola limitu
 * nie przecieka między projektami. */
function AutoModeSection({ project }: { project: ProjectListItem }) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [limitValue, setLimitValue] = useState(String(project.autoModeDailyLimit));

  const parsedLimit = Number(limitValue);
  const limitValid =
    limitValue.trim() !== '' &&
    Number.isInteger(parsedLimit) &&
    parsedLimit >= AUTO_LIMIT_MIN &&
    parsedLimit <= AUTO_LIMIT_MAX;
  const limitChanged = limitValid && parsedLimit !== project.autoModeDailyLimit;

  const modeMutation = useMutation({
    mutationFn: (autoMode: boolean) => api.patch<ProjectListItem>(`/projects/${project.id}`, { autoMode }),
    onSuccess: (_data, autoMode) => {
      setConfirmOpen(false);
      toast.success(autoMode ? 'Auto mode włączony' : 'Auto mode wyłączony');
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    onError: (err) => {
      setConfirmOpen(false);
      toast.error(describeApiError(err));
    },
  });

  const limitMutation = useMutation({
    mutationFn: (autoModeDailyLimit: number) =>
      api.patch<ProjectListItem>(`/projects/${project.id}`, { autoModeDailyLimit }),
    onSuccess: () => {
      toast.success('Limit auto-akceptacji zapisany');
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    onError: (err) => toast.error(describeApiError(err)),
  });

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-muted/40 px-3.5 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13.5px] font-medium text-foreground">Auto mode — zapisy agenta bez kolejki</span>
          <span className="text-xs text-muted-foreground">
            Zapisy agenta, które przejdą bezpieczniki (bez podobnych pamięci, bez korekty treści człowieka, w
            limicie), trafiają do pamięci od razu — bez przeglądu. Pozostałe czekają w kolejce z powodem.
          </span>
        </div>
        <Switch
          checked={project.autoMode}
          disabled={modeMutation.isPending}
          onCheckedChange={(checked) => {
            if (checked) setConfirmOpen(true);
            else modeMutation.mutate(false);
          }}
          aria-label="Auto mode — zapisy agenta bez kolejki"
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`auto-limit-${project.id}`} className="text-xs text-muted-foreground">
          Limit auto-akceptacji / 24 h ({AUTO_LIMIT_MIN}–{AUTO_LIMIT_MAX})
        </label>
        <div className="flex items-center gap-1.5">
          <Input
            id={`auto-limit-${project.id}`}
            type="number"
            min={AUTO_LIMIT_MIN}
            max={AUTO_LIMIT_MAX}
            step={1}
            value={limitValue}
            onChange={(e) => setLimitValue(e.target.value)}
            className="h-8 w-24 font-mono text-xs"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!limitChanged || limitMutation.isPending}
            onClick={() => limitMutation.mutate(parsedLimit)}
          >
            Zapisz
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !open && !modeMutation.isPending && setConfirmOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Włączyć auto mode dla „{project.name}”?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogDescription asChild>
            <div className="space-y-2.5 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Co się zmienia:</span> nowe zapisy agenta (także
                korekty <span className="font-mono">supersedes</span> i relacje) wchodzą do pamięci bez przeglądu
                człowieka.
              </p>
              <p>
                <span className="font-medium text-foreground">Nadal trafia do kolejki:</span> zapis podobny do
                istniejącej pamięci albo taki, którego nie dało się sprawdzić; korekta treści napisanej lub
                poprawionej przez człowieka; zapisy ponad limit ({project.autoModeDailyLimit} / 24 h).
              </p>
              <p>
                <span className="font-medium text-foreground">Bez zmian:</span> skaner sekretów, walidacja i
                wykrywanie identycznych duplikatów; propozycje nocnego joba i założenie projektu zawsze czekają na
                człowieka; obecne propozycje w kolejce zostają w kolejce.
              </p>
              <p>
                <span className="font-medium text-foreground">Widoczność:</span> zmiana trafia do audytu, a wpisy
                z auto mode znajdziesz w przeglądarce pamięci (filtr „auto-zaakceptowane”).
              </p>
            </div>
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={modeMutation.isPending}>Anuluj</AlertDialogCancel>
            <AlertDialogAction onClick={() => modeMutation.mutate(true)} disabled={modeMutation.isPending}>
              {modeMutation.isPending ? 'Włączanie…' : 'Włącz auto mode'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
