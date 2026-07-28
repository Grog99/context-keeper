import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Archive,
  Diamond,
  FolderKanban,
  History,
  Inbox,
  Moon,
  PlugZap,
  Plus,
  ScrollText,
  Sun,
  Wrench,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { type ScreenKey, useGlobalKeyboard } from '../hooks/useKeyboard';
import { api } from '../lib/api';
import { useActiveContext } from '../lib/context';
import { queryKeys } from '../lib/query';
import type { DashboardMetrics, ProjectListItem } from '../types/api';
import { CommandPalette } from './CommandPalette';
import { ContextSwitcher } from './ContextSwitcher';
import { HumanCreateDialog } from '../screens/HumanCreateDialog';
import { KeyboardCheatsheet } from './KeyboardCheatsheet';
import { MetricStat } from './MetricStat';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface RailNavItem {
  to: string;
  label: string;
  icon: typeof Inbox;
  screen: ScreenKey;
}

/** 7 ekranów kontekstowych — filtrowanych/scoped przez `ContextSwitcher` (§9.6). „Projekty" nie jest
 * tu, bo dotyczy ustawień całego projektu, nie wybranej pamięci — patrz `PROJECTS_NAV_ITEM`. */
const NAV_ITEMS: RailNavItem[] = [
  { to: '/kolejka', label: 'Kolejka', icon: Inbox, screen: 'kolejka' },
  { to: '/pamiec', label: 'Pamięć', icon: Archive, screen: 'pamiec' },
  { to: '/os-czasu', label: 'Oś czasu', icon: History, screen: 'os-czasu' },
  { to: '/audyt', label: 'Audyt', icon: ScrollText, screen: 'audyt' },
  { to: '/pomiary', label: 'Pomiary', icon: Activity, screen: 'pomiary' },
  { to: '/operacje', label: 'Operacje', icon: Wrench, screen: 'operacje' },
  { to: '/onboarding', label: 'Onboarding', icon: PlugZap, screen: 'onboarding' },
];

/** §9.3 — poza nawigacją kontekstową: dotyczy ustawień całego projektu (CRUD projektów, tokeny),
 * nie wybranej pamięci. Ląduje w dolnej sekcji railu, przy toggle motywu i „Wyloguj". */
const PROJECTS_NAV_ITEM: RailNavItem = { to: '/projekty', label: 'Projekty', icon: FolderKanban, screen: 'projekty' };

const SCREEN_PATH: Record<ScreenKey, string> = {
  kolejka: '/kolejka',
  pamiec: '/pamiec',
  'os-czasu': '/os-czasu',
  projekty: '/projekty',
  audyt: '/audyt',
  pomiary: '/pomiary',
  operacje: '/operacje',
  onboarding: '/onboarding',
};

/** Label paska zdrowia (FR-D7): `up`/`degraded` + latencja ostatniego health-checku, gdy znana. */
function embeddingStatusLabel(metrics: DashboardMetrics | undefined): string {
  if (!metrics) return '—';
  const base = metrics.embedding.status === 'up' ? 'up' : 'degraded';
  const { latencyMs } = metrics.embedding;
  return latencyMs === null ? base : `${base} · ${latencyMs}ms`;
}

/** Wspólny styling nav-linka railu — wyciągnięty, żeby `PROJECTS_NAV_ITEM` w dolnej sekcji (poza
 * `<nav>`) dostał identyczny stan aktywny co reszta `NAV_ITEMS`, zamiast dwóch miejsc renderowania
 * dryfujących wizualnie. */
function railNavLinkClass({ isActive }: { isActive: boolean }): string {
  return [
    'relative flex h-9 items-center gap-2.5 rounded-md px-2 text-[13.5px] font-medium text-muted-foreground transition-colors',
    'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    // Aktywna pozycja niesie akcent trzema kanałami (nie samym tłem): tint `accent-subtle`,
    // ikona w irysie i 2px pasek marki przy krawędzi railu — spójne z `ProposalRow` (§8.2).
    isActive &&
      "bg-accent-subtle text-foreground [&_svg]:text-primary before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-full before:bg-primary before:content-['']",
  ]
    .filter(Boolean)
    .join(' ');
}

interface RailNavLinkProps {
  item: RailNavItem;
  children?: ReactNode;
}

/** Pojedyncza pozycja railu (nawigacja kontekstowa LUB `PROJECTS_NAV_ITEM` w dolnej sekcji) —
 * jeden render site dla ikony + labelu + opcjonalnego slotu na badge (np. queue count). */
function RailNavLink({ item, children }: RailNavLinkProps) {
  return (
    <NavLink to={item.to} className={railNavLinkClass}>
      <item.icon className="size-[17px] text-faint" />
      {item.label}
      {children}
    </NavLink>
  );
}

/**
 * §9.0 design-systemu — rama wszystkich ekranów: rail (240px, marka → `ContextSwitcher` → nawigacja
 * 7 ekranów kontekstowych → "Nowa pamięć" → dolna sekcja: Projekty + toggle motywu + Wyloguj) + top
 * bar (52px: ⌘K search, health strip). Screeny renderują się przez `<Outlet/>` (React Router) —
 * AppShell sam nie zna treści ekranów, tylko ramę + skróty globalne.
 */
export function AppShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  const { active } = useActiveContext();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const anyDialogOpen = paletteOpen || cheatsheetOpen || createOpen;

  const { data: metrics } = useQuery({
    queryKey: queryKeys.metrics(),
    queryFn: () => api.get<DashboardMetrics>('/metrics'),
    refetchInterval: 20_000,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectListItem[]>('/projects'),
  });

  useGlobalKeyboard({
    enabled: !anyDialogOpen,
    onOpenPalette: () => setPaletteOpen(true),
    onOpenCheatsheet: () => setCheatsheetOpen(true),
    onNavigate: (screen) => navigate(SCREEN_PATH[screen]),
  });

  async function handleLogout(): Promise<void> {
    await api.post('/auth/logout');
    await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
  }

  const createDisabled = active.kind === 'all';
  const createScope = active.kind === 'project' ? 'project' : 'global';
  const createProjectId = active.kind === 'project' ? active.projectId : undefined;
  const createProjectName = active.kind === 'project' ? active.projectName : undefined;

  return (
    <div
      className="grid h-screen grid-cols-[240px_1fr] bg-background text-foreground"
      style={{ gridTemplateRows: 'minmax(0, 1fr)' }}
    >
      <aside className="flex min-h-0 flex-col gap-1 overflow-y-auto border-r border-border-strong bg-background p-3">
        <div className="flex items-center gap-2 px-2 pb-2.5 pt-1 text-[15px] font-semibold tracking-tight">
          <Diamond className="size-[22px] fill-primary text-primary" />
          Context Keeper
        </div>
        <ContextSwitcher projects={(projects ?? []).map((p) => ({ id: p.id, name: p.name }))} />
        <div className="px-2 pb-1 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
          Nawigacja
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <RailNavLink key={item.to} item={item}>
              {item.screen === 'kolejka' && metrics && metrics.queueDepth > 0 && (
                <span className="ml-auto rounded-full bg-primary px-[7px] py-px font-mono text-[11px] font-semibold text-primary-foreground">
                  {metrics.queueDepth}
                </span>
              )}
            </RailNavLink>
          ))}
        </nav>
        <div className="my-2.5 h-px bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={createDisabled}
              onClick={() => setCreateOpen(true)}
              className="flex h-9 items-center justify-center gap-2 rounded-md border border-dashed border-border-strong text-[13px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-border-strong disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-4" />
              Nowa pamięć
            </button>
          </TooltipTrigger>
          {createDisabled && (
            <TooltipContent>Wybierz projekt albo Global w przełączniku kontekstu, żeby utworzyć pamięć.</TooltipContent>
          )}
        </Tooltip>
        <div className="mt-auto flex flex-col gap-1 border-t border-border pt-2.5">
          <RailNavLink item={PROJECTS_NAV_ITEM} />
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            aria-label="Przełącz motyw"
            className="h-9 justify-start px-2 text-[13.5px] text-muted-foreground"
          >
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {theme === 'dark' ? 'Tryb jasny' : 'Tryb ciemny'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 justify-start px-2 text-[13.5px] text-muted-foreground"
            onClick={handleLogout}
          >
            Wyloguj
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col min-h-0">
        <header className="flex h-[52px] flex-none items-center gap-3.5 border-b border-border-strong bg-surface px-4">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 w-[280px] items-center gap-2 rounded-md border border-border bg-background px-2.5 text-[13px] text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SearchIcon />
            Szukaj pamięci…
            <kbd className="ml-auto rounded border border-border px-1.5 py-px font-mono text-[10.5px] text-faint">⌘K</kbd>
          </button>
          {/* Health strip jako jeden przyrząd: ramka + kanwa na białym top barze, zamiast czterech
              kafelków wiszących w powietrzu. Dividery niesie sam `MetricStat` (border-l). */}
          <div className="ml-auto flex items-stretch rounded-md border border-border bg-background py-0.5">
            <MetricStat label="Kolejka" value={metrics?.queueDepth ?? '—'} />
            <MetricStat
              label="Embedding"
              value={embeddingStatusLabel(metrics)}
              status={metrics ? (metrics.embedding.status === 'up' ? 'ok' : 'warn') : 'neutral'}
            />
            <MetricStat
              label="Nocny job"
              value={metrics?.nightlyRun ? '✓' : 'brak danych'}
              status={metrics ? (metrics.nightlyRun ? 'ok' : 'neutral') : 'neutral'}
            />
            <MetricStat
              label="Backup"
              value={metrics?.lastBackup ? (metrics.lastBackup.metadata?.status === 'failed' ? '✗ nieudany' : '✓') : 'brak danych'}
              status={
                metrics
                  ? metrics.lastBackup
                    ? metrics.lastBackup.metadata?.status === 'failed'
                      ? 'bad'
                      : 'ok'
                    : 'neutral'
                  : 'neutral'
              }
            />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <KeyboardCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />
      <HumanCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        scope={createScope}
        projectId={createProjectId}
        projectName={createProjectName}
      />
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" strokeLinecap="round" />
    </svg>
  );
}
