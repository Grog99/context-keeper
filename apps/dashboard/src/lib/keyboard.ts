export type ScreenKey =
  | 'kolejka'
  | 'pamiec'
  | 'os-czasu'
  | 'projekty'
  | 'audyt'
  | 'pomiary'
  | 'operacje'
  | 'onboarding'
  | 'ustawienia';

export const SCREEN_CHORD_KEYS: Readonly<Record<string, ScreenKey>> = {
  k: 'kolejka',
  p: 'pamiec',
  c: 'os-czasu', // "c" jak w "oś Czasu" — "o" jest już zajęte przez "operacje", "t"(imeline) nie po polsku
  t: 'projekty',
  a: 'audyt',
  m: 'pomiary', // "m" jak w "poMiary" — "p" jest już zajęte przez "pamiec"
  o: 'operacje',
  w: 'onboarding', // "w" jak w "onboardinW"/"welcome" — "o" jest już zajęte przez "operacje"
  s: 'ustawienia', // "s" jak "Settings" — "u" też wolne, ale "s" pasuje do skrótu `g s` z design-systemu (§9.9)
};

/** Okno na drugi klawisz akordu `g ‹litera›` — liczone od keydown `g`. */
export const CHORD_TIMEOUT_MS = 900;

export type QueueCommand =
  | 'next'
  | 'prev'
  | 'open'
  | 'approve'
  | 'reject'
  | 'edit'
  | 'supersede'
  | 'toggleSelect';

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** `KeyboardEvent.repeat` — klawisz jest przytrzymany (auto-powtarzanie); pominięte = `false`. */
  repeat?: boolean;
  /** Fokus w polu tekstowym (input / textarea / select / contenteditable). */
  editableTarget: boolean;
}

export interface KeyRoutingContext {
  /** Chwila keydown w ms (monotoniczna, np. `performance.now()`) — wygaśnięcie akordu liczymy z niej, bez timera. */
  now: number;
  /** `false` gdy otwarty jest dialog albo nie ma zamontowanych skrótów globalnych. */
  globalEnabled: boolean;
  /** `false` gdy ekran kolejki nie jest zamontowany albo jest w trybie edycji / z dialogiem. */
  queueEnabled: boolean;
}

export interface ChordState {
  /** Chwila uzbrojenia akordu (`g`) albo `null`, gdy akord nie jest uzbrojony. */
  readonly armedAt: number | null;
}

export const IDLE_CHORD: ChordState = { armedAt: null };

export type KeyRoute =
  | { kind: 'navigate'; screen: ScreenKey }
  | { kind: 'openPalette' }
  | { kind: 'openCheatsheet' }
  | { kind: 'queue'; command: QueueCommand }
  | { kind: 'none' };

export interface KeyRouting {
  chord: ChordState;
  route: KeyRoute;
  preventDefault: boolean;
}

/** Klawisze, które same niczego nie wpisują — keydown samego Shift/Ctrl/… nie przerywa akordu. */
const MODIFIER_ONLY_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock']);

function queueRoute(input: KeyInput, ctx: KeyRoutingContext): Pick<KeyRouting, 'route' | 'preventDefault'> {
  const none = { route: { kind: 'none' } as const, preventDefault: false };
  if (!ctx.queueEnabled) return none;
  if (input.metaKey || input.ctrlKey || input.altKey) return none;
  if (input.editableTarget) return none;

  switch (input.key) {
    case 'j':
      return { route: { kind: 'queue', command: 'next' }, preventDefault: true };
    case 'k':
      return { route: { kind: 'queue', command: 'prev' }, preventDefault: true };
    case 'Enter':
      return { route: { kind: 'queue', command: 'open' }, preventDefault: false };
    case 'a':
    case 'A':
      return { route: { kind: 'queue', command: 'approve' }, preventDefault: false };
    case 'r':
    case 'R':
      return { route: { kind: 'queue', command: 'reject' }, preventDefault: false };
    case 'e':
    case 'E':
      return { route: { kind: 'queue', command: 'edit' }, preventDefault: false };
    case 's':
    case 'S':
      return { route: { kind: 'queue', command: 'supersede' }, preventDefault: false };
    case 'x':
    case 'X':
      return { route: { kind: 'queue', command: 'toggleSelect' }, preventDefault: false };
    default:
      return none;
  }
}

/**
 * JEDYNE miejsce, które decyduje, czy klawisz trafia do nawigacji globalnej (ekran / paleta /
 * ściągawka), do komendy kolejki, czy donikąd (§10 design-systemu, roadmap v1.8 „Bugi z przeglądu UX").
 * Czysta funkcja: stan akordu wchodzi i wychodzi jako dane, czas przychodzi w `ctx.now`.
 *
 * Po `g` KAŻDY następny klawisz w oknie `CHORD_TIMEOUT_MS` należy do akordu: z mapy
 * `SCREEN_CHORD_KEYS` → ekran, każdy inny → nic (nigdy skrót kolejki — inaczej `g a` zatwierdzałoby
 * propozycję). Sam modyfikator (`Shift`, …) przechodzi bez zmiany akordu, żeby `g`, `Shift+A`
 * nawigowało, a nie zatwierdzało. `g` z Ctrl/Meta/Alt nie uzbraja akordu, a drugi klawisz akordu z
 * Ctrl/Meta/Alt jest połknięty (nie nawiguje). Auto-powtórzenie przytrzymanego `g` (`repeat`) nigdy
 * nie zużywa akordu — tylko odświeża okno, więc parzysta liczba powtórzeń nie rozbraja akordu.
 */
export function routeKey(chord: ChordState, input: KeyInput, ctx: KeyRoutingContext): KeyRouting {
  if (!ctx.globalEnabled) return { chord: IDLE_CHORD, ...queueRoute(input, ctx) };

  if (MODIFIER_ONLY_KEYS.has(input.key)) return { chord, route: { kind: 'none' }, preventDefault: false };

  const hasModifier = input.metaKey || input.ctrlKey || input.altKey;

  if ((input.metaKey || input.ctrlKey) && input.key.toLowerCase() === 'k') {
    return { chord: IDLE_CHORD, route: { kind: 'openPalette' }, preventDefault: true };
  }

  if (input.editableTarget) return { chord: IDLE_CHORD, route: { kind: 'none' }, preventDefault: false };

  if (input.key === 'g' && input.repeat === true && !hasModifier) {
    return { chord: { armedAt: ctx.now }, route: { kind: 'none' }, preventDefault: false };
  }

  const armed = chord.armedAt !== null && ctx.now - chord.armedAt < CHORD_TIMEOUT_MS;
  if (armed) {
    const screen = hasModifier ? undefined : SCREEN_CHORD_KEYS[input.key.toLowerCase()];
    if (screen) return { chord: IDLE_CHORD, route: { kind: 'navigate', screen }, preventDefault: true };
    return { chord: IDLE_CHORD, route: { kind: 'none' }, preventDefault: false };
  }

  if (input.key === 'g' && !hasModifier) {
    return { chord: { armedAt: ctx.now }, route: { kind: 'none' }, preventDefault: false };
  }
  if (input.key === '/') return { chord: IDLE_CHORD, route: { kind: 'openPalette' }, preventDefault: true };
  if (input.key === '?') return { chord: IDLE_CHORD, route: { kind: 'openCheatsheet' }, preventDefault: true };

  return { chord: IDLE_CHORD, ...queueRoute(input, ctx) };
}
