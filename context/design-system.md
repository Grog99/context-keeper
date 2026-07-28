# Context Keeper — Design System & UI

**Wersja:** v1 (Faza 1) · **Data:** 2026-07-22
**Źródła:** [`prd.md`](prd.md) (co/dlaczego), [`tech-stack.md`](tech-stack.md) (jak) · **Stack UI:** React SPA + **Tailwind CSS + shadcn/ui** (Radix) + **lucide-react**

> Ten dokument opisuje **jak wygląda i jak się zachowuje** dashboard recenzenta — jedyna powierzchnia dla człowieka.
> Zasada przewodnia (spójna z resztą projektu): **prosto w v1, tokeny i komponenty gotowe na rozszerzenia.**

---

## 0. Koncepcja: „Ruled ledger" — konsola operatora

Dashboard to **narzędzie, nie strona** — jest skanowany i obsługiwany, nie czytany od góry do dołu. Cała wartość v1 stoi na tym, że **jeden recenzent nadąża zatwierdzać** (PRD §3), więc naczelny cel UI to **przepustowość recenzenta**: minimum tarcia, maksimum sygnału, obsługa z klawiatury.

Charakter — przy zachowaniu minimalizmu — niosą **trzy sygnatury**, nie dekoracje:

1. **Monospace dla danych maszynowych.** Każdy identyfikator (`mem_a1b2c3`), token (`ck_…`), tag, `score`, znacznik czasu i **origin path** (`agent · project:acme`) idzie krojem monospace. To robi z interfejsu *rejestr / księgę pamięci* — tematycznie trafne dla memory-store — i natychmiast odróżnia go od generycznego dashboardu. Proza (nagłówki, body pamięci, UI chrome) idzie sans.
2. **Keyline zamiast kart.** Separacja przez cienkie linie i rytm typografii, nie przez ciężkie, zaokrąglone „karty z cieniem". Gęsto, ale spokojnie. Cień rezerwujemy dla elementów unoszących się (popover, dialog, toast).
3. **Jeden akcent marki, reszta koloru = semantyka.** Akcent **iris/fiolet** służy tylko marce i interakcji (focus, primary, aktywna nawigacja). Każdy inny kolor **coś znaczy** (status/provenance). Dyscyplina koloru jest tu tożsamością.

**Czego unikamy:** wielkiego „hero", gradientów, emoji jako znaczników sekcji, `rounded-lg` wszędzie, dekoracyjnej numeracji. Elegancja = precyzja odstępów, typografii i stanów.

---

## 1. Zasady projektowe

| # | Zasada | Konsekwencja w UI |
|---|---|---|
| P1 | **Summary before detail** | Nad każdą listą — pasek stanu (głębokość kolejki, zdrowie embeddingu, wynik nocnego jobu, blokady sekretów/24h). Szczegół dopiero po wejściu w pozycję. |
| P2 | **Stan kodowany formą, nie tylko liczbą** | `pending`/`stale`/`approved`/`secret_blocked` mają **chip + ikonę + label** — czytelne na pierwszy rzut oka, nie tylko kolorem. |
| P3 | **Kolor semantyczny ≠ akcent** | Iris to marka. Zielony/bursztyn/czerwony niosą znaczenie stanu i nigdy nie są „ozdobą". |
| P4 | **Klawiatura first-class** | Cała kolejka obsługiwalna bez myszy (§10). Widoczny `focus-visible`. |
| P5 | **Gęstość z rytmu** | Stałe wysokości wierszy, keyline, tabular-nums — nie ramki wokół wszystkiego. |
| P6 | **Nieodwracalne = tarcie celowe** | `reject`/`archive`/`promote`/`purge`/rotacja tokena → dialog potwierdzenia. Reszta = jeden klik/skrót. |
| P7 | **Degradacja widoczna, nie alarmująca** | Embedding-down = badge „degraded" (bursztyn) w pasku zdrowia, nie modal błędu. |
| P8 | **PL/EN bez masakry** | UI chrome po polsku; treść pamięci renderowana jak jest; identyfikatory monospace. |

---

## 2. Kolor

Neutralne **biasowane ciepło** (rodzina „stone", nie czysty szary) — dobrane, nie odziedziczone. Kanwa: ciepła prawie-biel (light) / ciepły „ink" prawie-czerń (dark, nie pure black). Akcent: **iris**.

### 2.1 Role semantyczne (hex, light → dark)

| Rola | Light | Dark | Użycie |
|---|---|---|---|
| `background` (kanwa) | `#FAFAF9` | `#141312` | tło aplikacji |
| `surface` | `#FFFFFF` | `#1B1A18` | panele, wiersze aktywne, popover |
| `surface-muted` | `#F5F5F4` | `#232120` | tła zagnieżdżone, hover row, code |
| `border` (keyline) | `#E7E5E4` | `#2C2A27` | linie separacji, obrys inputów |
| `border-strong` | `#D6D3D1` | `#3A3633` | obrys aktywny/hover, dividery mocniejsze |
| `text` | `#1C1917` | `#F5F3F0` | tekst główny |
| `text-muted` | `#57534E` | `#A8A29E` | tekst drugorzędny, etykiety |
| `text-faint` | `#A8A29E` | `#78716C` | placeholdery, metadane mniej ważne |
| **`accent` (iris)** | `#5B4BD6` | `#8B7CF6` | primary, focus ring, aktywna nawigacja, marka |
| `accent-hover` | `#4E3FC0` | `#9E90F8` | hover primary |
| `accent-subtle` | `#EEEBFB` | `#221E3A` | tło zaznaczenia/aktywnej pozycji, tint marki |
| `accent-fg` | `#FFFFFF` | `#15131F` | tekst na `accent` |

### 2.2 Paleta statusów (load-bearing)

Pięć znaczeń. Każde ma: `solid` (ikona/kropka/akcja), `subtle` (tło chipa), `fg` (tekst na subtle). Kolor **nigdy nie jest jedynym sygnałem** — zawsze towarzyszy ikona + label.

| Znaczenie | Ikona (lucide) | Solid L / D | Subtle L / D | Zastosowanie |
|---|---|---|---|---|
| **success** (approved, healthy, promote) | `check` / `circle-check` | `#16A34A` / `#4ADE80` | `#DCFCE7` / `#0F2A18` | zatwierdzone, zdrowy embedding, sukces nocnego jobu |
| **attention** (pending, degraded) | `clock` / `loader` | `#B45309` / `#FBBF24` | `#FEF3C7` / `#2A2008` | oczekuje na recenzję, tryb degraded |
| **danger** (secret_blocked, stale-block, destrukcja) | `shield-alert` / `lock` / `triangle-alert` | `#DC2626` / `#F87171` | `#FEE2E2` / `#2A1414` | blokada sekretu, stale (blokada approve), reject/purge |
| **info / hint** (dedup „similar", nightly origin) | `sparkles` / `moon` | `#5B4BD6` / `#8B7CF6` | `accent-subtle` | podpowiedź „similar to […]", znacznik nocnego jobu |
| **neutral** (archived, rejected, resolved) | `archive` / `x` | `#78716C` / `#A8A29E` | `surface-muted` | zarchiwizowane, odrzucone, stany zamknięte |

> **Uwaga o `stale` vs `secret_blocked`:** oba to „stop, potrzebny człowiek, zablokowane" → **wspólna rodzina danger**, różnicowane **ikoną + labelem** (`lock` „stale — bazowa rewizja się zmieniła" vs `shield-alert` „secret_blocked — rotuj credential"), nie odcieniem. Minimalizm zamiast dwóch czerwieni.

### 2.3 Kolor tożsamości (`kind`) — nie status, więc z innej rodziny

> Dopisane po rewizji kontrastu (2026-07-27). Zastępuje wcześniejszą regułę „`kind` zawsze neutralny".

`kind` (`fact`/`document`/`event`) dostaje **własny kolor**, ale należący do rozłącznej rodziny
znaczeniowej niż §2.2. Reguła P3 nie mówi „kolor tylko dla statusu" — mówi, że **każdy kolor coś
znaczy**. Tożsamość rekordu to prawomocne znaczenie; nielegalne jest dopiero mieszanie jej z sygnałem.

Trzy zasady, które trzymają te rodziny osobno:

1. **Hue z martwych stref koła.** Statusy zajmują 145° (zieleń), 35° (bursztyn), 5° (czerwień),
   250° (iris). `kind` bierze **petrol ~198°** i **wrzos ~312°** — pasma, w których nie ma żadnego
   znaczenia z §2.2, więc pomyłka „to chyba ostrzeżenie" jest strukturalnie niemożliwa.
2. **Niska chroma jako część kontraktu** (~22–30% nasycenia). Nasycony kolor czyta się jako sygnał;
   przygaszony czyta się jako barwiony papier. Podbicie nasycenia tych tokenów łamie regułę,
   nawet jeśli hue zostaje.
3. **`fact` nie ma koloru.** Najczęstszy kind zostaje neutralną bazą — kolorowanie wszystkich trzech
   zwróciłoby ścianę koloru, przed którą broni cała ta sekcja.

| Rola | Light | Dark | Użycie |
|---|---|---|---|
| `kind-document` | `#4C7788` | `#79ADC3` | gutter wiersza, obrys markera |
| `kind-document-subtle` | `#E3EDF1` | `#1D2D34` | tło markera |
| `kind-document-foreground` | `#2B5464` | `#BAD3DE` | ikona na `subtle` |
| `kind-event` | `#955F8B` | `#C695BC` | gutter (kropkowany), obrys markera |
| `kind-event-subtle` | `#F2E9F0` | `#352231` | tło markera |
| `kind-event-foreground` | `#63365A` | `#DEC4D9` | ikona na `subtle`, stempel `event_time` |

**Kolor jest tu kanałem trzecim, nie jedynym** (P2). `kind` niesie równolegle: **kształt** (gutter
przy lewej krawędzi — `fact` żaden, `document` pełny, `event` kropkowany), **ikonę**
(`notebook`/`file-text`/`clock` w `KindMarker`) i dopiero **kolor**. Wyłączenie koloru zostawia
działające rozróżnienie — to jest test, który każda zmiana w tej sekcji musi przejść.

Implementacja: [`components/KindMarker.tsx`](../apps/dashboard/src/components/KindMarker.tsx)
(`KindMarker` + `KindGutter`) — jedno miejsce definicji, konsumowane przez wiersz i detal §9.2.

### 2.4 Provenance (origin) — nie status, więc dyskretnie

Origin (`agent` / `human` / `nightly`) renderujemy jako **mono „origin path"** z drobną ikoną, w kolorze `text-muted` — z jednym wyjątkiem: `nightly` dostaje tint `info` (bo jego propozycje mają inny profil zaufania i recenzent chce je odróżniać na liście).

```
agent   · project:acme     ○ text-muted   (ikona: bot)
human   · global           ○ text-muted   (ikona: user)
nightly · project:acme     ◆ info tint     (ikona: moon)
```

---

## 3. Typografia

- **Sans (UI + proza):** produkcyjnie **Inter** (self-hosted, bez CDN). Fallback: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- **Mono (dane maszynowe — sygnatura):** produkcyjnie **JetBrains Mono**. Fallback: `ui-monospace, "SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace`.
- **Display:** brak osobnego kroju — tytuły to ten sam sans w większym stopniu z ciaśniejszym trackingiem. Restraint jest celem.

### Skala (dense operator console, baza 14px)

| Token | px / line-height | Waga | Zastosowanie |
|---|---|---|---|
| `text-2xs` | 11 / 16 | 500 | mono metadane, mikro-labelki chipów, UPPERCASE eyebrow (+0.04em) |
| `text-xs` | 12 / 16 | 400–500 | metadane, pomocnicze, tagi |
| `text-sm` | 13 / 18 | 400 | **domyślny w gęstych obszarach** (wiersze kolejki, listy) |
| `text-base` | 14 / 20 | 400 | domyślny UI, formularze |
| `text-md` | 15 / 24 | 400 | **body pamięci** (proza do czytania), max ~65–72 zn. szerokości |
| `text-lg` | 18 / 26 | 500 | nagłówki paneli, tytuł proposala |
| `text-xl` | 22 / 30 | 600 | tytuły ekranów |
| `text-2xl` | 28 / 34 | 600 | rzadko — puste stany, onboarding |

**Reguły:** wagi tylko 400/500/600 (bez ciężkich). Cyfry w kolumnach → `font-variant-numeric: tabular-nums`. Nagłówki → `text-wrap: balance`. Body → `text-wrap: pretty`, szerokość ~65 zn. UPPERCASE tylko na eyebrow/label z trackingiem +0.04em.

---

## 4. Spacing, radius, elewacja, keyline

- **Spacing:** skala 4px — `1=4, 2=8, 3=12, 4=16, 5=20, 6=24, 8=32, 10=40, 12=48`. Layout przez flex/grid + `gap`, nie marginesy per-element.
- **Radius (minimalny):** `sm=4` (chip, input, mały button), `md=6` (button, panel, popover — **domyślny**), `lg=8` (dialog), `full` (kropki statusu, avatar). Bez `rounded-2xl`.
- **Keyline:** separacja to `1px` linia `border`. Wiersze list — dolny keyline, bez ramek dookoła. Sekcje — `border-strong` gdy trzeba mocniej.
- **Elewacja (oszczędnie):**
  - `shadow-sm` — `0 1px 2px rgb(0 0 0 / .06)` — hover na interaktywnym wierszu (subtelnie).
  - `shadow-md` — `0 8px 24px -6px rgb(0 0 0 / .16)` — popover, dropdown, dialog, toast.
  - W dark cienie słabsze; separację niesie głównie keyline + `surface` jaśniejsza od `background`.
- **Gęstość — stałe wysokości:**
  - wiersz kolejki / listy pamięci: **48px** (`h-12`), compact toggle → 40px.
  - top bar: **52px**; rail nav item: **36px**; chip: **22px** (`h-[22px]`).

---

## 5. Motion

Szybko i dyskretnie — ruch służy orientacji, nie efektowi.

| Wzorzec | Czas / easing |
|---|---|
| hover / kolor / tło | 120ms `ease-out` |
| wejście panelu detalu / drawer | 180ms `cubic-bezier(.2,.8,.2,1)` |
| popover / dropdown | 140ms `ease-out` (opacity + 4px translate) |
| toast in/out | 160ms |
| skeleton shimmer | 1.2s liniowo, subtelny |

**Zawsze** respektuj `prefers-reduced-motion: reduce` → przejścia do ~0ms, bez translate. Bez bounce, bez parallax.

---

## 6. Ikonografia

- **lucide-react**, stroke 1.5–1.75px, rozmiary **16 / 18 / 20**. Line, nie fill (spójne z minimalizmem).
- Kluczowe: `clock` (pending), `circle-check` (approved), `archive`, `lock` (stale), `shield-alert` (secret_blocked), `sparkles` (dedup hint), `moon` (nightly), `bot`/`user` (origin), `git-merge` (merge), `trash-2` (delete/purge), `arrow-left-right` (update diff), `replace` („zatwierdź jako zamiennik"), `key-round` (token), `folder` (projekt), `search`, `filter`, `pencil` (edit).
- **Emoji: nie** (poza ewentualnym pustym stanem, i to z umiarem).

---

## 7. Design tokens → Tailwind + shadcn

shadcn/ui czyta tokeny jako CSS variables. Poniżej gotowy fundament — semantyka shadcn (`background`, `foreground`, `primary`, `muted`, `border`, `ring`…) **rozszerzona** o tokeny statusów (`success`/`warning`/`danger`/`info` + `-subtle`/`-foreground`).

### 7.1 `globals.css` (fragment)

```css
:root {
  /* neutrals + surface (warm stone) */
  --background: #FAFAF9;
  --foreground: #1C1917;
  --surface: #FFFFFF;
  --muted: #F5F5F4;          /* surface-muted */
  --muted-foreground: #57534E;
  --faint: #A8A29E;
  --border: #E7E5E4;
  --border-strong: #D6D3D1;
  --input: #E7E5E4;

  /* brand accent — iris */
  --primary: #5B4BD6;
  --primary-hover: #4E3FC0;
  --primary-foreground: #FFFFFF;
  --accent-subtle: #EEEBFB;
  --ring: #5B4BD6;

  /* status — semantyka (para: solid + subtle + foreground-on-subtle) */
  --success: #16A34A;  --success-subtle: #DCFCE7;  --success-foreground: #14532D;
  --warning: #B45309;  --warning-subtle: #FEF3C7;  --warning-foreground: #78350F;
  --danger:  #DC2626;  --danger-subtle:  #FEE2E2;  --danger-foreground:  #7F1D1D;
  --info:    #5B4BD6;  --info-subtle:    #EEEBFB;  --info-foreground:    #372F8C;
  --neutral: #78716C;  --neutral-subtle: #F5F5F4;  --neutral-foreground: #44403C;

  --radius: 6px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #141312;
    --foreground: #F5F3F0;
    --surface: #1B1A18;
    --muted: #232120;
    --muted-foreground: #A8A29E;
    --faint: #78716C;
    --border: #2C2A27;
    --border-strong: #3A3633;
    --input: #2C2A27;

    --primary: #8B7CF6;
    --primary-hover: #9E90F8;
    --primary-foreground: #15131F;
    --accent-subtle: #221E3A;
    --ring: #8B7CF6;

    --success: #4ADE80;  --success-subtle: #0F2A18;  --success-foreground: #BBF7D0;
    --warning: #FBBF24;  --warning-subtle: #2A2008;  --warning-foreground: #FDE68A;
    --danger:  #F87171;  --danger-subtle:  #2A1414;  --danger-foreground:  #FECACA;
    --info:    #8B7CF6;  --info-subtle:    #221E3A;  --info-foreground:    #DDD6FE;
    --neutral: #A8A29E;  --neutral-subtle: #232120;  --neutral-foreground: #E7E5E4;
  }
}

/* Toggle użytkownika musi wygrać z media query — w obie strony */
:root[data-theme="dark"]  { /* …te same wartości co blok dark… */ }
:root[data-theme="light"] { /* …te same wartości co blok light… */ }
```

> **Uwaga implementacyjna:** trzymaj wartości dark w jednym miejscu (np. mixin/@apply lub duplikacja), tak by `@media` **i** `:root[data-theme="dark"]` dawały ten sam wynik. To wymóg z artifact-design: toggle stampuje `data-theme` na `<html>` i musi nadpisać preferencję OS.

### 7.2 `tailwind.config.ts` (extend)

```ts
export default {
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        surface: "var(--surface)",
        muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" },
        border: "var(--border)",
        primary: { DEFAULT: "var(--primary)", hover: "var(--primary-hover)", foreground: "var(--primary-foreground)" },
        success: { DEFAULT: "var(--success)", subtle: "var(--success-subtle)", foreground: "var(--success-foreground)" },
        warning: { DEFAULT: "var(--warning)", subtle: "var(--warning-subtle)", foreground: "var(--warning-foreground)" },
        danger:  { DEFAULT: "var(--danger)",  subtle: "var(--danger-subtle)",  foreground: "var(--danger-foreground)" },
        info:    { DEFAULT: "var(--info)",    subtle: "var(--info-subtle)",    foreground: "var(--info-foreground)" },
        neutral: { DEFAULT: "var(--neutral)", subtle: "var(--neutral-subtle)", foreground: "var(--neutral-foreground)" },
      },
      borderRadius: { lg: "8px", md: "6px", sm: "4px" },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', '16px'], xs: ['12px','16px'], sm: ['13px','18px'],
        base: ['14px','20px'], md: ['15px','24px'], lg: ['18px','26px'],
        xl: ['22px','30px'], '2xl': ['28px','34px'],
      },
    },
  },
}
```

---

## 8. Biblioteka komponentów (mapping na shadcn/ui)

Bazujemy na shadcn (kopiowane do repo → pełna kontrola). Poniżej — bazowe + **własne, produktowe** (te drugie są sercem systemu).

### 8.1 Bazowe (shadcn, przetematyzowane tokenami)

| Komponent | Uwagi tematyzacji |
|---|---|
| `Button` | warianty: `primary` (iris solid), `secondary` (obrys `border-strong`), `ghost`, `destructive` (danger). Rozmiary `sm/md`. Radius `md`. |
| `Badge` | patrz **StatusChip** (własny wariant). |
| `Select` / `Command` | context switcher + filtry. `Command` (⌘K palette) do szybkiej nawigacji. |
| `Tabs` | w detalu proposala/pamięci: `Diff` / `Metadane` / `Rewizje`. |
| `Dialog` / `AlertDialog` | potwierdzenia destrukcyjne (P6), token reveal, human-create. |
| `Toast` (sonner) | wynik akcji: „Zatwierdzono", „Odrzucono", „Token skopiowany". |
| `Tooltip` | absolutny czas przy relatywnym, pełny origin, wyjaśnienie badge. |
| `Input` / `Textarea` | obrys `input`, focus ring iris. Textarea body = mono? nie — sans, `text-md`. |
| `Skeleton` | ładowanie list; shimmer subtelny (§5). |
| `Separator` | keyline. |

### 8.2 Własne (produktowe)

**`StatusChip`** — sygnatura. `h-[22px]`, radius `sm`, `text-2xs` uppercase +0.04em, ikona 12–14px + label + (opcjonalnie kropka). Warianty = paleta statusów (§2.2). **Kolor + ikona + label razem** (P2).

```
[● PENDING]  [✓ APPROVED]  [🗄 ARCHIVED]  [🔒 STALE]  [⚠ SECRET_BLOCKED]
```

**`OriginPath`** — mono, `text-xs`, `text-muted`; `nightly` z tint `info` i ikoną `moon`. Format `źródło · scope[:projekt]`.

**`MonoId`** — `mem_…`/`ck_…`/`rev_…` w mono `text-xs`, klik = kopiuj (toast). Token zawsze maskowany poza jednorazowym reveal.

**`ProposalRow`** — wiersz kolejki `h-12`: `[StatusChip] [type ikona] Header (truncate) … [OriginPath] [tagi ≤2 + „+N"] [czas rel.]`. Stale → dodatkowy `danger` badge po prawej. Hover `surface-muted`, aktywny `accent-subtle` + lewy pasek `2px` iris.

**`DiffView`** — **zależny od `type`** (FR-D1). Najbardziej produktowy komponent:

| `type` | Render |
|---|---|
| `create` | jeden blok „nowa treść" — cały body na zielonym tint `success-subtle`, lewy pasek success. |
| `update` | word-level inline diff (nagłówek + treść, ten sam renderer dla obu): niezmienione słowa zwykłym tekstem, usunięte pod `<del>` (`bg-danger-subtle`/`text-danger-foreground`, przekreślenie), dodane pod `<ins>` (`bg-success-subtle`/`text-success-foreground`, podkreślenie), legenda `−/+` nad blokiem. Poniżej progu czytelności (patrz akapit „Inline diff (`update`)") fallback do dawnego układu dwóch bloków `del`/`add` obok siebie. |
| `merge` | trzy karty: **A** + **B** (obie → archiwum, `neutral`/przekreślone nagłówki) **→ C** (nowa, `success`). Ikona `git-merge`. |
| `delete`/`prune` | tombstone — cały rekord przygaszony, `danger` label „do archiwizacji", powód (np. „stale: last_accessed 94 dni, access_count 0"). |

**Inline diff (`update`)** — word-level diff liczony przez [`diff`](https://www.npmjs.com/package/diff) (jsdiff) `diffWords`, w `apps/dashboard/src/lib/text-diff.ts` (`computeInlineWordDiff`), osobno dla nagłówka i dla treści. Diff ignoruje białe znaki przy porównaniu równości, ale zachowuje je w outpucie — poprawne dla zawijanej prozy PL/EN; białe znaki na granicy zmiany są zawsze renderowane jako zwykły tekst, nigdy pod `<del>`/`<ins>`, żeby tint nie obejmował samej spacji. Cztery nieomijalne/omijalne guardy z typowanym powodem fallbacku:

- **`'too-long'`** — suma długości `before`+`after` > 20 000 znaków. Sprawdzane PRZED wywołaniem jsdiffa (Myers jest O(N·D); `BODY_MAX_DOCUMENT` dopuszcza dokumenty dużo większe niż da się bezpiecznie zdiffować w głównym wątku przeglądarki). **Twardy limit, bez toggle'a.**
- **`'aborted'`** — jsdiff wywołany z `timeout: 250` ms i tak nie zdążył — druga siatka bezpieczeństwa pod progiem długości. **Twardy limit, bez toggle'a.**
- **`'too-different'`** — ponad 70% znaków to dodania/usunięcia (mniej niż 30% treści przetrwało diff niezmienione) — ściana kolorów inline byłaby mniej czytelna niż dwa czyste bloki before/after. To wyłącznie heurystyka czytelności, nie ograniczenie wydajności, więc recenzent dostaje link „Pokaż zmiany inline mimo to" pod fallbackiem, żeby próg obejść; segmenty są policzone z góry, toggle nie liczy diffa ponownie.
- **`'whitespace-only'`** — stringi się różnią, ale diff nie znalazł żadnych zmian słów (czysty reflow/wcięcie) — nic do podświetlenia, fallback z notką wyjaśniającą.

A11y (§10, P2 — kolor nigdy nie jest jedynym sygnałem): usunięcia/dodania niosą trzy redundantne kanały — semantykę (prawdziwe `<del>`/`<ins>`, nie `<span>`), kształt (przekreślenie/podkreślenie) i etykietę (legenda ikona+label nad blokiem, mirror `StatusChip`), plus `role="group"`/`aria-label` na kontenerze. Świadomie bez per-span `sr-only` markerów — na diffie długości akapitu zamieniłoby to output screen readera w szum. Diff działa na surowym źródle markdown (`whitespace-pre-wrap`, bez `react-markdown`) — jak reszta `DiffView` (`MemoryBrowserScreen` to jedyny konsument `react-markdown` w dashboardzie).

Zależność `diff@^9.0.0` (BSD-3-Clause) jest dodana WYŁĄCZNIE do `apps/dashboard/package.json` — świadomie **bez** `@types/diff` (ten pakiet typuje starszy kształt v5 i przesłoniłby własne typy v9 dołączone w paczce; `moduleResolution: "Bundler"` poprawnie rozwiązuje jej mapę `exports`).

**`ProposalActions`** — sticky bar u dołu detalu: `Zatwierdź` (primary, skrót **A**), `Odrzuć` (ghost-danger, **R**), `Edytuj` (secondary, **E**), oraz split-button **`Zatwierdź jako zamiennik ▾`** (**S**, wybór X spośród „similar/affected"). Przy `stale` → primary **disabled** + inline alert z powodem i CTA „Przejrzyj różnicę / Zaktualizuj bazę".

**`DedupHint`** — pod headerem, `info` alert inline: `sparkles` + „Podobne do: `mem_x`, `mem_y`" (klik → podgląd). Nie blokuje (advisory, FR-M3).

**`RevisionTimeline`** — pionowa oś w detalu pamięci: każda rewizja = `rev_…` (mono), autor (origin), czas, akcja (`created`/`edited`/`promote`/`superseded-by`). Supersession linkuje do zamiennika.

**`MetricStat`** — kafelek paska zdrowia: label `text-2xs` uppercase, wartość `text-lg` tabular-nums, kropka statusu. Warianty: liczba (queue depth), health-dot (embedding up/degraded), wynik (nightly ✓ 3 created), licznik alertu (`secret_blocked` /24h — czerwony gdy >0).

**`TokenReveal`** — Dialog jednorazowego pokazania `ck_…`: duży mono, `Kopiuj`, wyraźne ostrzeżenie „Zobaczysz to raz. W bazie trzymamy tylko hash." Po zamknięciu — nieodwracalnie zamaskowany. Pokazuje też etykietę tokena (atrybucja per-agent, v1.3); przy `reason="rotated"` ostrzeżenie zmienia się na okno karencji („Stary token działa jeszcze do [data] — zaktualizuj klientów MCP") zamiast hard-cutover.

**`TokenStatusBadge`** (v1.3) — badge `effectiveStatus` tokena, ikona+kolor+label (P2): `active`→success „aktywny", `grace`→pending „karencja", `expired`→neutral „wygasły", `revoked`→danger „unieważniony". `effectiveStatus` liczony WYŁĄCZNIE server-side (`effectiveTokenStatus`, jedna reguła dzielona z auth) — SPA nigdy nie wyprowadza tego sama z `status`+`expiresAt`.

**`ContextSwitcher`** — w top barze: `Wszystkie` / `Global` / `‹projekty…›` (Command-search po nazwie). Aktywny kontekst dziedziczy cała aplikacja (FR-D6). `Wszystkie` → tryb read/inbox (human-create **wyłączony**, widoczna adnotacja dlaczego).

**`EmptyState`** — np. kolejka pusta: spokojny „Inbox zero — brak propozycji do przeglądu", ikona line, bez clip-artu.

---

## 9. Wzorce ekranów

### 9.0 App shell (rama wszystkich ekranów)

```
┌──────────┬──────────────────────────────────────────────────────────────┐
│  RAIL     │  TOP BAR: [ContextSwitcher ▾]  [🔍 search]      [health strip] [◐]│
│ (240px)   ├──────────────────────────────────────────────────────────────┤
│ ◆ Keeper  │                                                                │
│           │                     GŁÓWNY OBSZAR EKRANU                        │
│ ▸ Kolejka⁷│                                                                │
│   Pamięć  │                                                                │
│   Projekty│                                                                │
│   Audyt   │                                                                │
│  ────────  │                                                               │
│ ＋ Nowa    │                                                               │
│           │                                                                │
│ mini-metry│                                                                │
└──────────┴──────────────────────────────────────────────────────────────┘
```

- **Rail (240px):** marka („◆ Context Keeper"), nawigacja 4 ekranów (Kolejka z badge liczby pending), przycisk `＋ Nowa pamięć` (aktywny tylko gdy kontekst = konkretny/Global), na dole mini-metryki (queue depth, health-dot).
- **Top bar (52px):** `ContextSwitcher` (lewo) · search (`⌘K`) · **health strip** (MetricStat ×4) · toggle motywu.
- **Health strip** jest wszechobecny (P1) — recenzent zawsze widzi głębokość kolejki, zdrowie embeddingu, wynik nocnego jobu, `secret_blocked`/24h.

### 9.1 Kolejka akceptacji (FR-D1) — ekran-bohater, layout list/detail

```
┌ lista (38%) ──────────────┬ detal (62%) ───────────────────────────┐
│ Filtry: [origin ▾][type ▾]│ Header proposala            [StatusChip] │
│ ─────────────────────────  │ OriginPath · tagi · czas                │
│ ● PENDING create  ····· 2m│ ─────────────────────────────────────── │
│ ◆ nightly merge   ····· 1h│ [DedupHint: podobne do mem_x]           │
│ 🔒 STALE update   ····· 3h│ ┌ Tabs: Diff | Metadane | Rewizje ────┐ │
│ ● PENDING create  ····· 5h│ │  DiffView (zależny od type)          │ │
│                            │ │                                       │ │
│                            │ └──────────────────────────────────────┘ │
│                            │ ─ sticky ProposalActions ─────────────── │
│                            │ [Zatwierdź A][Odrzuć R][Edytuj E][▾ zam.]│
└───────────────────────────┴──────────────────────────────────────────┘
```

- **Lewa:** filtry `origin`/`type`; lista `ProposalRow`. Badge stale widoczny na wierszu.
- **Prawa:** header + `OriginPath` + tagi; `DedupHint` (jeśli jest); Tabs `Diff`/`Metadane`/`Rewizje`; sticky `ProposalActions`.
- **Stany specjalne:** `stale` → primary disabled + alert danger z powodem; `edit-before-approve` → header/body stają się edytowalne inline, akcja zmienia się na „Zatwierdź z edycją" (badge „approved with edits").
- **Klawiatura:** `j/k` nawigacja, `A/R/E`, `S` zamiennik, `Enter` otwiera, `/` search.

### 9.2 Przeglądarka pamięci (FR-D2) — list/detail

- **Filtry:** `scope` (toggle group: wg kontekstu), `kind` (`fact`/`document`/`event`, v1.2), status (`approved`/`archived`), tagi (multi), search.
- **Lista:** wiersze jak kolejka, ale zamiast StatusChip pending → `kind` + `scope` + `access_count`/`last_accessed` (mono, tabular). `archived` przygaszone.
  - **Rozróżnienie `kind` (§2.3)** trzema kanałami: `KindGutter` przy lewej krawędzi (kształt +
    kolor), `KindMarker` zamiast dawnego neutralnego `Badge variant="kind"` (ikona + kolor) oraz
    **rytm wiersza** — `document` zawija nagłówek do dwóch linii (`line-clamp-2`) zamiast go
    urywać, więc różni się sylwetką, nie samym tintem. Wysokość wiersza przestaje być stała
    (min. 56px); to świadome odstępstwo od P5 na rzecz skanowalności listy.
  - `event` dokłada `event_time` jako mono stempel w pasku metadanych, w kolorze
    `kind-event-foreground`.
  - Gutter ustępuje miejsca pasKowi zaznaczenia: wiersz wybrany pokazuje 2px iris (jak w kolejce),
    nie gutter kind — zaznaczenie ma pierwszeństwo przed tożsamością.
  - **Znane ograniczenie:** `MemoryListItem` nie niesie `body`, więc `document` nie ma dwuliniowego
    excerptu (byłby mocniejszym nośnikiem rytmu niż zawinięty nagłówek). Wymaga pola `excerpt`
    w DTO listy po stronie serwera — nierobione.
- **Detal:** `header`, `body` (proza `text-md`, ~65 zn.), metadane (id, scope, kind, source, created/updated/approved, `access_count`, `last_accessed`), `RevisionTimeline`. Akcje człowieka = **commit bezpośredni** + revision: `Edytuj`, `Archiwizuj`, `Promuj do global`, `Zmień scope/kind`. Wszystkie destrukcyjne → AlertDialog.
- **document vs fact:** `document` dostaje szerszy obszar czytania i (v1.1) lepszy edytor; `fact` kompaktowo.
- **`kind=event` (v1.2):** `KindMarker` we wrzosie (§2.3) — **zastąpiło** dawny neutralny badge
  `variant="kind"` i jego uzasadnienie („kolor zarezerwowany dla statusu, nie typu"); reguła zmieniła
  się 2026-07-27 na „kolor tożsamości z rozłącznej rodziny hue". `event_time` wyróżnia wpis dodatkowo
  — renderowany z ikoną zegara (`Clock`, `lucide-react`) w wierszu listy, w pasku metadanych detalu
  i w tabie „Metadane". `event_time` **nie** jest edytowalny z formularza edycji (ustawiany raz przy
  tworzeniu, v1) — `Edytuj` zmienia tylko header/body/tagi jak dla fact/document.
- **Gdzie `Badge variant="kind"` zostaje:** w kontekstach, gdzie `kind` jest etykietą obcego rekordu,
  nie tożsamością wiersza — `RelationsPanel` i `ProposalRelations` (targety relacji). Tam neutralność
  jest celowa: kolor tożsamości ma wyróżniać rekord na liście, a nie każde wystąpienie słowa.

### 9.3 Projekty / tokeny (FR-D3) — poza context switcherem (lista wszystkich)

- **Lista projektów:** nazwa, `project_id` (mono), liczba pamięci, data utworzenia, **liczniki tokenów**
  (v1.3 — badge „N aktywne" + „M karencja", zastępuje dawny 1:1 status tokena — patrz `ProjectListItem.tokenCounts`).
- **Akcje:** `Nowy projekt` (z wymaganą etykietą pierwszego tokena, prefill `default`), `Tokeny` (ikona
  ⚙-sąsiad) → otwiera `ProjectTokensDialog` (v1.3), ikona ⚙ → `ProjectSettingsDialog`.
- **`ProjectTokensDialog` (v1.3)** — dialog per projekt, sibling `ProjectSettingsDialog`: tabela
  tokenów (etykieta inline-editable z ołówkiem, `TokenStatusBadge`, `tok_…` mono, utworzony/wygasa/
  ostatnio użyty, wyszukań 30 dni, akcje), formularz „Nowy token" (etykieta wymagana), per-wiersz
  `Rotuj` (tylko `active` — AlertDialog wyjaśnia okno karencji, potem `TokenReveal`) i `Unieważnij`
  (dowolny nie-`revoked` — AlertDialog destrukcyjny, dodatkowe ostrzeżenie gdy to ostatni usable token
  projektu, nie blokujące). Mutacje invalidują zarówno listę tokenów, jak i listę projektów (liczniki).
- **`TokenReveal`:** po utworzeniu projektu/tokena LUB rotacji — Dialog jednorazowy z `ck_…`, etykietą,
  `Kopiuj`; przy rotacji komunikat okna karencji zamiast hard-cutover (patrz §8.2).
- **`ProjectSettingsDialog` (v1.2):** osobny dialog szczegółów projektu (NIE inline switch w wierszu
  tabeli) — dziś jedno pole: `Switch` „Dołączaj zdarzenia do domyślnego wyszukiwania"
  (`include_events_in_default_search`). Zmiana audytowana jako `project_settings_changed`, widoczna
  na ekranie „Audyt" bez dodatkowej pracy UI.
- Ten ekran **ignoruje** ContextSwitcher (zarządza kontekstami, nie żyje w jednym).

### 9.4 Audyt (FR-D4) — tabela zdarzeń + rewizje

- **Filtry:** `event_type` (m.in. `secret_blocked`, `purge_tombstone`, `nightly_run`, `proposal_*`, `promote`, `archive`, `token_*`), zakres czasu, projekt.
- **Tabela:** czas (mono, tabular) · `event_type` (chip) · aktor (`OriginPath`/`human-dashboard`) · `affected_ids` (mono, klik → pamięć) · `rev_…`.
- **`secret_blocked`** wyróżniony `danger` — to sygnał rotacji/unieważnienia; wiersz linkuje do projektu/tokena z CTA „Zarządzaj tokenem" (v1.3 — operator wybiera `Rotuj` albo `Unieważnij` w `ProjectTokensDialog`).
- **`token_revoked`** (v1.3, ikona `shield-off`, `danger`) i **`token_relabeled`** (v1.3, ikona `pencil`, `neutral`) dołączone do `token_*` — aktor niesie dodatkowy chip z `metadata.tokenLabel`, gdy obecny (agent-path eventy: `proposal_created`, `secret_blocked`).
- **Sekcja `revisions`:** przegląd historii zmian (before/after) niezależnie od kolejki.

### 9.5 Human-create (FR-D5) — Dialog/drawer „Nowa pamięć"

- Wyzwalane z railu; dostępne tylko gdy kontekst = konkretny projekt lub `Global` (w `Wszystkie` — disabled + wyjaśnienie).
- Pola: `kind` (segmented `fact`/`document`/`event`, v1.2), `header` (licznik ~200 zn.), `body` (`textarea`, licznik per-kind cap; dla `document` większy obszar), `tags` (chip-input z normalizacją na blur: trim+lowercase+collapse, walidacja charset/limit).
- **`kind=event` (v1.2):** dodatkowe pole „Kiedy się wydarzyło" (`datetime-local`, domyślnie teraz) —
  backdatable, przyszłe daty dozwolone bez walidacji blokującej (decay je traktuje jak „teraz").
- **Import:** zakładka „Wklej" / „Wgraj `.md`" (drop-zone, bez bulk).
- Miękkie „similar existing memories" (opcjonalnie) — `DedupHint` przed zapisem.
- Zapis = commit bezpośredni (`source=human`), toast „Utworzono".

### 9.6 Context switcher (FR-D6)

- W top barze, `Command`-search. `Wszystkie` = zunifikowany inbox recenzenta (create off). Widok projektu **strict** (tylko pamięci projektu; `global` osobno). Zmiana kontekstu przeładowuje listy, ale zachowuje aktywny ekran.

### 9.7 Oś czasu (v1.2, `kind=event`) — chronologiczna lista, grupowana wg dnia

- **Route/label:** `/os-czasu`, „Oś czasu" — spójne z polskimi slugami (`/kolejka`, `/pamiec`, `/operacje`). Skrót klawiaturowy `g c`.
- **Zawartość:** WYŁĄCZNIE `kind=event`, status `approved`, sortowane `event_time DESC`. Scoped przez `ContextSwitcher` jak przeglądarka pamięci (§9.6) — `project` strict, bez leakage.
- **Grupowanie: wg dnia kalendarzowego** (lokalna strefa przeglądarki) — nagłówek dnia (np. „środa,
  22 lipca 2026", ruled-ledger styl jak reszta ekranów) + wpisy pod spodem, każdy z godziną (mono,
  tabular), headerem, originem (`OriginPath`) i tagami. Bez osobnego panelu detalu — klik na wiersz
  otwiera pełny szczegół w „Pamięć" (`/pamiec?id=`).
- **Tworzenie:** wyłącznie przez `HumanCreateDialog` (`kind=Zdarzenie`) — patrz §9.5.
- **Puste/loading:** `EmptyState`/`Skeleton` jak reszta list (§10).

---

## 10. Stany, dostępność, klawiatura

- **Focus:** zawsze widoczny `focus-visible` — ring 2px iris + offset 2px. Nawigacja Tab przez wszystkie interaktywne.
- **Kontrast:** cel **WCAG AA** (tekst ≥4.5:1, UI/ikony ≥3:1). Palety §2 dobrane pod to w obu motywach; status-fg na status-subtle spełnia AA.
- **Kolor nie jest jedynym sygnałem** (P2): każdy status = kolor **+ ikona + label**.
- **Klawiatura (kolejka):** `j/k` góra/dół, `Enter` detal, `A` approve, `R` reject, `E` edit, `S` zamiennik, `/` search, `⌘K` paleta poleceń, `g` potem `k/p/c/t/a/m/o/w` — skok do ekranu (Kolejka/Pamięć/Oś czasu/Projekty/Audyt/Pomiary/Operacje/Onboarding). Skróty widoczne w tooltipach i „?" cheatsheet.
- **Reduced motion:** `prefers-reduced-motion` → bez translate/shimmer.
- **Empty / loading / error:** każdy list ma `EmptyState`, `Skeleton`, i inline error (nie modal) z akcją „Ponów".
- **Live vs polling:** v1 kolejka odświeżana pollingiem — pokaż „ostatnia aktualizacja Xs temu" + ręczny refresh; bez fałszywego „real-time".

---

## 11. Treść, i18n, formatowanie

- **Język:** UI chrome po polsku; **treść pamięci renderowana jak jest** (PL/EN mieszane). Nie tłumaczymy body.
- **Copy = materiał:** przyciski mówią co robią („Zatwierdź" → toast „Zatwierdzono"). Błędy: co poszło nie tak + jak naprawić, bez przeprosin. Nazwy z perspektywy człowieka (recenzent widzi „propozycję", nie „proposal row”).
- **Czas:** relatywny („2 min temu") + absolutny w tooltipie; `created_at` monospace tabular w audycie.
- **Liczby w kolumnach:** `tabular-nums`.
- **Identyfikatory:** zawsze mono; klik = kopiuj. Token maskowany poza reveal.
- **Markdown:** `body` renderowane jako markdown (nagłówki, listy, code). Code-block w `surface-muted`, mono.

---

## 12. Co dalej (implementacja)

1. **Fundament tokenów** — wklej §7 do `globals.css` + `tailwind.config`, dołóż self-hosted Inter + JetBrains Mono (`@font-face`, woff2 w repo — bez CDN).
2. **shadcn init** — dodaj bazowe komponenty (§8.1), nadpisz tokenami.
3. **Komponenty produktowe** (§8.2) — zacznij od `StatusChip`, `ProposalRow`, `DiffView`, `ProposalActions` (ścieżka krytyczna kolejki).
4. **Ekran-bohater** — Kolejka (§9.1) end-to-end na realnym API, potem Pamięć/Projekty/Audyt.
5. **A11y pass** — focus, kontrast, klawiatura (§10) jako część „definition of done", nie po fakcie.

**Poza v1 (spójne z roadmapą PRD §10):** bulk approve/reject (anti-fatigue) — layout kolejki już to udźwignie (checkbox na wierszu + bulk bar); ręczny trigger nocnego jobu i hard-purge w dashboardzie (v1.1) — miejsce w Audycie/Projektach; per-user auth (v2) — rail dostanie sekcję konta.

---

*Makieta klikalna kluczowych ekranów: [`design-system-mockup.html`](design-system-mockup.html).*
