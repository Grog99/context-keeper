import { useEffect, useRef } from 'react';
import { type ChordState, IDLE_CHORD, type QueueCommand, routeKey, type ScreenKey } from '../lib/keyboard';

export type { ScreenKey } from '../lib/keyboard';

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
  /** Bulk selection (roadmap v1.3, "Bulk approve/reject w kolejce") — `x` przełącza zaznaczenie
   * BIEŻĄCEJ (podglądanej) propozycji. Osobny skrót od `A`/`R`, które świadomie zostają WYŁĄCZNIE
   * jednoelementowe (bezpieczeństwo — nie mają odpalać bulku, nawet gdy zaznaczenie jest niepuste). */
  onToggleSelect: () => void;
  /** `false` gasi cały hook (np. tryb edycji inline albo otwarty AlertDialog) — inaczej `e`/`a`
   * wpisywane w polu edycji odpaliłyby akcje (choć `isEditableTarget` już to łapie dla pól
   * formularza, `enabled` daje dodatkową kontrolę z poziomu ekranu, np. gdy fokus jest na przycisku). */
  enabled?: boolean;
}

export interface GlobalKeyboardHandlers {
  onNavigate: (screen: ScreenKey) => void;
  onOpenPalette: () => void;
  onOpenCheatsheet: () => void;
  /** `false` gdy jakikolwiek Dialog/AlertDialog jest otwarty (Radix i tak przechwytuje Escape/fokus,
   * ale bez tego `g k` przeskoczyłoby ekran POD otwartym dialogiem). */
  enabled?: boolean;
}

const QUEUE_COMMAND_HANDLERS: Record<QueueCommand, (handlers: QueueKeyboardHandlers) => void> = {
  next: (h) => h.onNext(),
  prev: (h) => h.onPrev(),
  open: (h) => h.onOpen(),
  approve: (h) => h.onApprove(),
  reject: (h) => h.onReject(),
  edit: (h) => h.onEdit(),
  supersede: (h) => h.onSupersede(),
  toggleSelect: (h) => h.onToggleSelect(),
};

// --- Router: jeden listener `keydown` na `document` dla obu hooków -------------------------------
// Dwa niezależne listenery (kolejka + globalny) łapały ten sam keydown: `g a` nawigowało do audytu
// ORAZ zatwierdzało propozycję (roadmap v1.8, "Bugi z przeglądu UX"). Teraz oba hooki tylko
// rejestrują swoje "latest handlers" w slocie, a decyzję, dokąd trafia klawisz, podejmuje
// `routeKey` (`lib/keyboard.ts`) — kolejność rejestracji efektów nie ma znaczenia. Stan modułu
// zmieniamy wyłącznie z efektów / handlerów zdarzeń przez helpery poniżej, nigdy w trakcie render.

type Slot<T> = { current: T } | null;

let chord: ChordState = IDLE_CHORD;
let globalSlot: Slot<GlobalKeyboardHandlers> = null;
let queueSlot: Slot<QueueKeyboardHandlers> = null;
let subscribers = 0;

function onDocumentKeyDown(event: KeyboardEvent): void {
  const global = globalSlot?.current;
  const queue = queueSlot?.current;
  const routing = routeKey(
    chord,
    {
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      repeat: event.repeat,
      editableTarget: isEditableTarget(event.target),
    },
    {
      now: performance.now(),
      globalEnabled: global !== undefined && global.enabled !== false,
      queueEnabled: queue !== undefined && queue.enabled !== false,
    },
  );
  chord = routing.chord;
  if (routing.preventDefault) event.preventDefault();

  const { route } = routing;
  switch (route.kind) {
    case 'navigate':
      global?.onNavigate(route.screen);
      return;
    case 'openPalette':
      global?.onOpenPalette();
      return;
    case 'openCheatsheet':
      global?.onOpenCheatsheet();
      return;
    case 'queue':
      if (queue) QUEUE_COMMAND_HANDLERS[route.command](queue);
      return;
    case 'none':
      return;
  }
}

function resetChord(): void {
  chord = IDLE_CHORD;
}

/** Dodaje listener przy pierwszym subskrybencie, zdejmuje przy ostatnim (licznik przeżywa StrictMode). */
function subscribe(): () => void {
  if (subscribers === 0) document.addEventListener('keydown', onDocumentKeyDown);
  subscribers += 1;
  return () => {
    subscribers -= 1;
    if (subscribers === 0) {
      document.removeEventListener('keydown', onDocumentKeyDown);
      resetChord();
    }
  };
}

/** §10 design-systemu — nawigacja kolejki: `j/k` góra/dół, `Enter` otwiera, `A/R/E/S` akcje, `x`
 * toggle zaznaczenia (bulk, roadmap v1.3). Nieaktywne gdy fokus jest w polu edytowalnym albo z
 * modyfikatorem (Cmd/Ctrl/Alt) — nie kolidować z skrótami przeglądarki/OS ani z wpisywaniem tekstu.
 * Nie nasłuchuje sam: rejestruje handlery w routerze (jeden listener, decyzja w `routeKey`), a skrót
 * po `g` należy do akordu nawigacji — nigdy nie dociera tu (`g a` ≠ zatwierdzenie). */
export function useQueueKeyboard(handlers: QueueKeyboardHandlers): void {
  const ref = useRef(handlers);
  // Aktualizacja "latest ref" MUSI żyć w efekcie, nie w ciele render (react-hooks/refs, React
  // Compiler) — commituje się po każdym renderze, przed jakąkolwiek następną interakcją klawiatury.
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    queueSlot = ref;
    const unsubscribe = subscribe();
    return () => {
      if (queueSlot === ref) queueSlot = null;
      unsubscribe();
    };
  }, []);
}

/** §9.0/§10 — skróty globalne (rail + top bar): `⌘K`/`Ctrl+K` paleta poleceń, `/` (deleguje do
 * palety — jeden punkt wejścia do wyszukiwania, jak w makiecie), `g` potem `k/p/c/t/a/m/o/w/s` skok do
 * ekranu, `?` ściągawka skrótów. Jak `useQueueKeyboard` — tylko rejestracja w routerze. */
export function useGlobalKeyboard(handlers: GlobalKeyboardHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    globalSlot = ref;
    const unsubscribe = subscribe();
    return () => {
      if (globalSlot === ref) globalSlot = null;
      resetChord();
      unsubscribe();
    };
  }, []);

  // Dialog otwarty myszą w trakcie uzbrojonego akordu: po zamknięciu nie wolno trzymać `g`.
  const enabled = handlers.enabled !== false;
  useEffect(() => {
    if (!enabled) resetChord();
  }, [enabled]);
}
