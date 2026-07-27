import { diffWords } from 'diff';
import type { Change } from 'diff';

/** Pomocnicza (nie-komponentowa) logika `components/DiffView.tsx`, wydzielona do osobnego pliku —
 * `react-refresh/only-export-components` (patrz `eslint.config.mjs`) wymaga, żeby plik komponentu
 * eksportował WYŁĄCZNIE komponenty. Ten sam wzorzec co `lib/usage-chart.ts` dla `UsageChart.tsx`. */

/** Powyżej tej sumy znaków (`before.length + after.length`) NIE wywołujemy jsdiffa w ogóle — Myers
 * jest O(N·D), a `BODY_MAX_DOCUMENT` (256 KB, `apps/server/src/memory/validation.ts`) dopuszcza
 * dokumenty dużo większe niż to, co da się bezpiecznie zdiffować w głównym wątku przeglądarki.
 * Twardy, nieomijalny limit — sprawdzany PRZED wywołaniem jsdiffa. */
export const WORD_DIFF_MAX_CHARS = 20_000;

/** Druga siatka bezpieczeństwa: nawet pod progiem długości patologiczny przypadek mógłby liczyć się
 * długo — jsdiff przerywa po tym czasie i zwraca `undefined` zamiast zamrażać kartę. */
export const WORD_DIFF_TIMEOUT_MS = 250;

/** Jeśli więcej niż 70% znaków to dodania/usunięcia (czyli mniej niż 30% tekstu przetrwało diff
 * niezmienione), ściana kolorów inline jest mniej czytelna niż dwa czyste bloki before/after. Próg
 * domyślny — user może go obejść ręcznym toggle w `DiffView` (D9), więc to heurystyka czytelności,
 * nie twarde ograniczenie wydajności jak `WORD_DIFF_MAX_CHARS`/`WORD_DIFF_TIMEOUT_MS`. */
export const MAX_CHANGED_RATIO = 0.7;

export interface InlineDiffSegment {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Drabinka fallbacków z typowanym powodem (nie goły `null`). `'too-long'`/`'aborted'` to twarde
 * zabezpieczenia wydajności — celowo BEZ `segments` (nic nie policzono / policzenie się nie
 * skończyło). `'too-different'`/`'whitespace-only'` NIOSĄ `segments`, mimo że `ok: false` — UI może
 * je i tak pokazać (ręczny toggle dla `'too-different'`, patrz `DiffView.tsx`/D9). */
export type InlineDiffResult =
  | { ok: true; segments: InlineDiffSegment[] }
  | { ok: false; reason: 'too-long' | 'aborted' }
  | { ok: false; reason: 'too-different' | 'whitespace-only'; segments: InlineDiffSegment[] };

const LEAD_TEXT_TRAIL = /^(\s*)([\s\S]*?)(\s*)$/;

function pushSegment(segments: InlineDiffSegment[], type: InlineDiffSegment['type'], text: string) {
  if (text) segments.push({ type, text });
}

/** Word-level inline diff dla `DiffView` case `update` (§8.2 design-systemu). Czysta funkcja — brak
 * hooków, memoizacja (re-render 1 Hz z `QueueScreen`) leży po stronie wywołującego komponentu.
 * `diffWords` (nie `diffWordsWithSpace`/`diffChars`) — ignoruje białe znaki przy porównaniu równości,
 * zachowuje je w outpucie (D2), poprawne dla zawijanej prozy PL/EN. */
export function computeInlineWordDiff(before: string, after: string): InlineDiffResult {
  if (before.length + after.length > WORD_DIFF_MAX_CHARS) {
    return { ok: false, reason: 'too-long' };
  }

  // Przekazanie `timeout` wybiera przeciążenie abortable jsdiffa (v9) → `Change[] | undefined`,
  // `undefined` = przerwane. `Change.added`/`removed` to wymagane booleany w v9 (opcjonalne w v5).
  const changes: Change[] | undefined = diffWords(before, after, { timeout: WORD_DIFF_TIMEOUT_MS });
  if (!changes) {
    return { ok: false, reason: 'aborted' };
  }

  const segments: InlineDiffSegment[] = [];
  let changedChars = 0;
  let totalChars = 0;
  let hasChange = false;

  for (const change of changes) {
    totalChars += change.value.length;

    if (!change.added && !change.removed) {
      pushSegment(segments, 'same', change.value);
      continue;
    }

    changedChars += change.value.length;
    hasChange = true;

    // D5 — białe znaki wyniesione poza tintowany span, żeby `<del>`/`<ins>` nie podkreślały/
    // przekreślały spacji na granicy słów (jsdiff dołącza otaczające whitespace do tokenu).
    const [, lead, text, trail] = change.value.match(LEAD_TEXT_TRAIL) ?? ['', '', change.value, ''];
    const type: InlineDiffSegment['type'] = change.added ? 'add' : 'del';
    pushSegment(segments, 'same', lead);
    pushSegment(segments, type, text);
    pushSegment(segments, 'same', trail);
  }

  if (totalChars > 0 && changedChars / totalChars > MAX_CHANGED_RATIO) {
    return { ok: false, reason: 'too-different', segments };
  }

  if (!hasChange) {
    return { ok: false, reason: 'whitespace-only', segments };
  }

  return { ok: true, segments };
}
