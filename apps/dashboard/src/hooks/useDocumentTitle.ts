import { useEffect } from 'react';

/** Ustawia `document.title` (§9.0 design-systemu); tytuł wylicza czysta funkcja `documentTitle`. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
