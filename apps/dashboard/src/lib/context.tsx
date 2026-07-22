import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/** Aktywny kontekst (FR-D6, §9.6 design-systemu): `all` = "Wszystkie" (unifikowany inbox, create
 * off), `global`, albo konkretny projekt. Dziedziczy cała aplikacja — wątkowany w klucze zapytań
 * i parametry API list (`contextQueryParams` niżej). */
export type ActiveContext =
  | { kind: 'all' }
  | { kind: 'global' }
  | { kind: 'project'; projectId: string; projectName: string };

interface ActiveContextState {
  active: ActiveContext;
  setActive: (ctx: ActiveContext) => void;
}

const ActiveContextCtx = createContext<ActiveContextState | null>(null);

const STORAGE_KEY = 'ck_active_context';

function loadInitial(): ActiveContext {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { kind: 'all' };
    const parsed = JSON.parse(raw) as ActiveContext;
    if (parsed && typeof parsed === 'object' && 'kind' in parsed) return parsed;
  } catch {
    // localStorage niedostępny (private mode) albo zepsuty JSON — po prostu startujemy od "Wszystkie".
  }
  return { kind: 'all' };
}

export function ActiveContextProvider({ children }: { children: ReactNode }) {
  const [active, setActiveState] = useState<ActiveContext>(loadInitial);

  function setActive(ctx: ActiveContext): void {
    setActiveState(ctx);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ctx));
    } catch {
      // nieszkodliwe — kontekst po prostu nie przetrwa reload
    }
  }

  const value = useMemo<ActiveContextState>(() => ({ active, setActive }), [active]);
  return <ActiveContextCtx.Provider value={value}>{children}</ActiveContextCtx.Provider>;
}

export function useActiveContext(): ActiveContextState {
  const ctx = useContext(ActiveContextCtx);
  if (!ctx) throw new Error('useActiveContext must be used within ActiveContextProvider');
  return ctx;
}

/** Parametry query dla list scoped po aktywnym kontekście — `project` STRICT (bez leakage global,
 * §9.6), `all` bez filtra (dashboard trusted, NFR-1). */
export function contextQueryParams(ctx: ActiveContext): Record<string, string> {
  switch (ctx.kind) {
    case 'all':
      return {};
    case 'global':
      return { scope: 'global' };
    case 'project':
      return { scope: 'project', projectId: ctx.projectId };
  }
}
