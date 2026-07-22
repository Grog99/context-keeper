import { useEffect, useRef } from 'react';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export interface QueueKeyboardHandlers {
  onNext: () => void;
  onPrev: () => void;
  onOpen: () => void;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
  onSupersede: () => void;
  /** `false` gasi cały hook (np. tryb edycji inline albo otwarty AlertDialog) — inaczej `e`/`a`
   * wpisywane w polu edycji odpaliłyby akcje (choć `isEditableTarget` już to łapie dla pól
   * formularza, `enabled` daje dodatkową kontrolę z poziomu ekranu, np. gdy fokus jest na przycisku). */
  enabled?: boolean;
}

/** §10 design-systemu — nawigacja kolejki: `j/k` góra/dół, `Enter` otwiera, `A/R/E/S` akcje.
 * Nieaktywne gdy fokus jest w polu edytowalnym albo z modyfikatorem (Cmd/Ctrl/Alt) — nie kolidować
 * z skrótami przeglądarki/OS ani z wpisywaniem tekstu. */
export function useQueueKeyboard(handlers: QueueKeyboardHandlers): void {
  const ref = useRef(handlers);
  // Aktualizacja "latest ref" MUSI żyć w efekcie, nie w ciele render (react-hooks/refs, React
  // Compiler) — commituje się po każdym renderze, przed jakąkolwiek następną interakcją klawiatury.
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (ref.current.enabled === false) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      switch (event.key) {
        case 'j':
          event.preventDefault();
          ref.current.onNext();
          return;
        case 'k':
          event.preventDefault();
          ref.current.onPrev();
          return;
        case 'Enter':
          ref.current.onOpen();
          return;
        case 'a':
        case 'A':
          ref.current.onApprove();
          return;
        case 'r':
        case 'R':
          ref.current.onReject();
          return;
        case 'e':
        case 'E':
          ref.current.onEdit();
          return;
        case 's':
        case 'S':
          ref.current.onSupersede();
          return;
        default:
          return;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}

export type ScreenKey = 'kolejka' | 'pamiec' | 'projekty' | 'audyt';

export interface GlobalKeyboardHandlers {
  onNavigate: (screen: ScreenKey) => void;
  onOpenPalette: () => void;
  onOpenCheatsheet: () => void;
  /** `false` gdy jakikolwiek Dialog/AlertDialog jest otwarty (Radix i tak przechwytuje Escape/fokus,
   * ale bez tego `g k` przeskoczyłoby ekran POD otwartym dialogiem). */
  enabled?: boolean;
}

const SCREEN_CHORD_KEYS: Record<string, ScreenKey> = { k: 'kolejka', p: 'pamiec', t: 'projekty', a: 'audyt' };
const CHORD_TIMEOUT_MS = 900;

/** §9.0/§10 — skróty globalne (rail + top bar): `⌘K`/`Ctrl+K` paleta poleceń, `/` (deleguje do
 * palety — jeden punkt wejścia do wyszukiwania, jak w makiecie), `g` potem `k/p/t/a` skok do ekranu,
 * `?` ściągawka skrótów. */
export function useGlobalKeyboard(handlers: GlobalKeyboardHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  const chordArmedRef = useRef(false);
  const chordTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    function disarm(): void {
      chordArmedRef.current = false;
      if (chordTimerRef.current) clearTimeout(chordTimerRef.current);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (ref.current.enabled === false) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        disarm();
        ref.current.onOpenPalette();
        return;
      }

      if (isEditableTarget(event.target)) return;

      if (chordArmedRef.current) {
        disarm();
        const screen = SCREEN_CHORD_KEYS[event.key.toLowerCase()];
        if (screen) {
          event.preventDefault();
          ref.current.onNavigate(screen);
        }
        return;
      }

      if (event.key === 'g') {
        chordArmedRef.current = true;
        chordTimerRef.current = setTimeout(disarm, CHORD_TIMEOUT_MS);
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        ref.current.onOpenPalette();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        ref.current.onOpenCheatsheet();
        return;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      disarm();
    };
  }, []);
}
