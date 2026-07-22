import { useCallback, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'ck_theme';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStored(): Theme | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === 'dark' || raw === 'light' ? raw : null;
}

/** Toggle motywu (§7.1 design-systemu — musi wygrać z `prefers-color-scheme` w OBIE strony).
 * Stampuje `data-theme` na `<html>`; `globals.css` ma reguły `:root[data-theme="..."]` dla obu. */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => readStored() ?? systemTheme());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // nieszkodliwe — motyw po prostu nie przetrwa reload
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
