import { describe, expect, it } from 'vitest';
import type { ChordState, KeyInput, KeyRoute, KeyRoutingContext, QueueCommand, ScreenKey } from '../src/lib/keyboard';
import { IDLE_CHORD, routeKey } from '../src/lib/keyboard';

/** Nadpisania jednego kroku: modyfikatory / pole edycyjne (`KeyInput`) i przełączniki skrótów (`KeyRoutingContext`). */
type StepOverrides = Partial<Omit<KeyInput, 'key'> & Omit<KeyRoutingContext, 'now'>>;
/** `[klawisz, chwila keydown w ms, nadpisania?]`. */
type Step = readonly [key: string, at: number, overrides?: StepOverrides];

/**
 * Składa `routeKey` po sekwencji klawiszy, przenosząc stan akordu między krokami, i zbiera trasy.
 * Domyślnie: oba zestawy skrótów włączone, bez modyfikatorów, cel nieedycyjny.
 */
function routeSequence(steps: readonly Step[], defaults: StepOverrides = {}): KeyRoute[] {
  let chord: ChordState = IDLE_CHORD;
  const routes: KeyRoute[] = [];
  for (const [key, at, overrides] of steps) {
    const o = { ...defaults, ...overrides };
    const result = routeKey(
      chord,
      {
        key,
        metaKey: o.metaKey ?? false,
        ctrlKey: o.ctrlKey ?? false,
        altKey: o.altKey ?? false,
        editableTarget: o.editableTarget ?? false,
        repeat: o.repeat ?? false,
      },
      { now: at, globalEnabled: o.globalEnabled ?? true, queueEnabled: o.queueEnabled ?? true },
    );
    chord = result.chord;
    routes.push(result.route);
  }
  return routes;
}

const navigate = (screen: ScreenKey): KeyRoute => ({ kind: 'navigate', screen });
const queue = (command: QueueCommand): KeyRoute => ({ kind: 'queue', command });
const NONE: KeyRoute = { kind: 'none' };

function queueRoutes(routes: readonly KeyRoute[]): KeyRoute[] {
  return routes.filter((route) => route.kind === 'queue');
}

/** Automatyczne powtórzenie keydown przytrzymanego `g` (`KeyboardEvent.repeat`). */
const heldG = (at: number): Step => ['g', at, { repeat: true }];

describe('routeKey — akord g ‹litera› ma pierwszeństwo przed skrótami kolejki (roadmap v1.8, Bugi z przeglądu UX)', () => {
  it('`g` `a` przechodzi do audytu i nie zatwierdza propozycji', () => {
    const routes = routeSequence([
      ['g', 0],
      ['a', 100],
    ]);

    expect(routes[1]).toEqual(navigate('audyt'));
    expect(queueRoutes(routes)).toEqual([]);
  });

  it.each([
    ['s', 'ustawienia', 'supersede'],
    ['k', 'kolejka', 'prev'],
  ] as const)('`g` `%s` → ekran %s, nie komenda kolejki %s', (key, screen, command) => {
    const routes = routeSequence([
      ['g', 0],
      [key, 100],
    ]);

    expect(routes[1]).toEqual(navigate(screen));
    expect(routes).not.toContainEqual(queue(command));
    expect(queueRoutes(routes)).toEqual([]);
  });

  it.each(['r', 'e', 'x', 'j', 'Enter', 'g'])(
    '`g` `%s` (klawisz spoza mapy akordu) → nic, nigdy kolejka; akord zużyty, kolejne `a` zatwierdza',
    (key) => {
      const routes = routeSequence([
        ['g', 0],
        [key, 100],
        ['a', 200],
      ]);

      expect(routes[1]).toEqual(NONE);
      expect(queueRoutes(routes.slice(0, 2))).toEqual([]);
      expect(routes[2]).toEqual(queue('approve'));
    },
  );

  it('`a` po upływie okna akordu (1000 ms po `g`) → zatwierdzenie', () => {
    const routes = routeSequence([
      ['g', 0],
      ['a', 1000],
    ]);

    expect(routes[1]).toEqual(queue('approve'));
  });

  it('`a` tuż przed końcem okna akordu (899 ms po `g`) → audyt', () => {
    const routes = routeSequence([
      ['g', 0],
      ['a', 899],
    ]);

    expect(routes[1]).toEqual(navigate('audyt'));
  });

  it('sam Shift w trakcie akordu go nie przerywa: `g`, Shift, `A` → audyt, bez komendy kolejki', () => {
    const routes = routeSequence([
      ['g', 0],
      ['Shift', 50],
      ['A', 100],
    ]);

    expect(routes[2]).toEqual(navigate('audyt'));
    expect(queueRoutes(routes)).toEqual([]);
  });

  it.each([
    { count: 1, repeats: [heldG(500)], aAt: 600 },
    { count: 2, repeats: [heldG(500), heldG(530)], aAt: 630 },
  ])(
    'przytrzymane `g` (auto-powtórzeń: $count) nie przełącza akordu: kolejne `a` → audyt, bez komendy kolejki',
    ({ repeats, aAt }) => {
      const routes = routeSequence([['g', 0], ...repeats, ['a', aAt]]);

      expect(routes[routes.length - 1]).toEqual(navigate('audyt'));
      expect(queueRoutes(routes)).toEqual([]);
    },
  );

  it('przytrzymane `g` dłużej niż okno akordu: auto-powtórzenia odświeżają okno, `a` → audyt', () => {
    const routes = routeSequence([['g', 0], heldG(500), heldG(800), heldG(1100), ['a', 1200]]);

    expect(routes[4]).toEqual(navigate('audyt'));
    expect(queueRoutes(routes)).toEqual([]);
  });
});

describe('routeKey — skróty kolejki bez akordu (roadmap v1.8, Bugi z przeglądu UX)', () => {
  it.each([
    ['j', 'next'],
    ['k', 'prev'],
    ['Enter', 'open'],
    ['a', 'approve'],
    ['A', 'approve'],
    ['R', 'reject'],
    ['E', 'edit'],
    ['S', 'supersede'],
    ['x', 'toggleSelect'],
  ] as const)('`%s` → komenda kolejki %s', (key, command) => {
    expect(routeSequence([[key, 0]])).toEqual([queue(command)]);
  });
});

describe('routeKey — wyłączone skróty globalne albo kolejki (roadmap v1.8, Bugi z przeglądu UX)', () => {
  it('skróty globalne wyłączone (otwarty dialog): `g` `a` → zatwierdzenie, kolejka nie jest blokowana', () => {
    const routes = routeSequence(
      [
        ['g', 0],
        ['a', 100],
      ],
      { globalEnabled: false },
    );

    expect(routes[1]).toEqual(queue('approve'));
  });

  it('po dialogu nie zostaje uzbrojony akord: `g`, Escape przy wyłączonych globalnych, `a` → zatwierdzenie', () => {
    const routes = routeSequence([
      ['g', 0],
      ['Escape', 100, { globalEnabled: false }],
      ['a', 200],
    ]);

    expect(routes[2]).toEqual(queue('approve'));
  });

  it('skróty kolejki wyłączone: `a` → nic', () => {
    expect(routeSequence([['a', 0]], { queueEnabled: false })).toEqual([NONE]);
  });

  it('skróty kolejki wyłączone: `g` `a` nadal przechodzi do audytu', () => {
    const routes = routeSequence(
      [
        ['g', 0],
        ['a', 100],
      ],
      { queueEnabled: false },
    );

    expect(routes[1]).toEqual(navigate('audyt'));
  });
});

describe('routeKey — pole edycyjne i modyfikatory (roadmap v1.8, Bugi z przeglądu UX)', () => {
  it('`a` w polu edycyjnym → nic', () => {
    expect(routeSequence([['a', 0, { editableTarget: true }]])).toEqual([NONE]);
  });

  it('`g` w polu edycyjnym nie uzbraja akordu: kolejne `a` poza polem → zatwierdzenie', () => {
    const routes = routeSequence([
      ['g', 0, { editableTarget: true }],
      ['a', 100],
    ]);

    expect(routes[1]).toEqual(queue('approve'));
  });

  it('Ctrl+K w polu edycyjnym → paleta', () => {
    expect(routeSequence([['k', 0, { ctrlKey: true, editableTarget: true }]])).toEqual([{ kind: 'openPalette' }]);
  });

  it('Ctrl+`a` → nic', () => {
    expect(routeSequence([['a', 0, { ctrlKey: true }]])).toEqual([NONE]);
  });

  it('Ctrl+`g` nie uzbraja akordu: kolejne `a` → zatwierdzenie', () => {
    const routes = routeSequence([
      ['g', 0, { ctrlKey: true }],
      ['a', 100],
    ]);

    expect(routes[1]).toEqual(queue('approve'));
  });

  it('`/` → paleta', () => {
    expect(routeSequence([['/', 0]])).toEqual([{ kind: 'openPalette' }]);
  });

  it('`?` → ściągawka skrótów', () => {
    expect(routeSequence([['?', 0]])).toEqual([{ kind: 'openCheatsheet' }]);
  });

  it('Ctrl+K przy uzbrojonym akordzie → paleta, a kolejne `a` → zatwierdzenie', () => {
    const routes = routeSequence([
      ['g', 0],
      ['k', 100, { ctrlKey: true }],
      ['a', 200],
    ]);

    expect(routes[1]).toEqual({ kind: 'openPalette' });
    expect(routes[2]).toEqual(queue('approve'));
  });
});
