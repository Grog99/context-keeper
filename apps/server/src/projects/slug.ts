import { ToolError } from '../common/errors';

/**
 * Slug projektu (roadmap v1.5, "Wskazanie projektu nagłówkiem" — ticket #16): stabilny, czytelny
 * identyfikator wpisywany do commitowanego `.mcp.json` (`X-Context-Keeper-Project: <slug>`).
 * Format `^[a-z0-9]+(-[a-z0-9]+)*$`, 2–48 znaków, unikalny w `projects` (indeks + CHECK w migracji
 * 0012). Moduł jest CZYSTY (bez DB) — te same reguły transliteracji/kolizji ma SQL-owy backfill w
 * `db/migrations/0012_account_tokens_project_slug.sql`; zmieniając jedno, zmień drugie (test
 * `project-slug.migration.spec.ts` pilnuje parytetu na wspólnej tabeli przypadków).
 */

export const PROJECT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PROJECT_SLUG_MIN = 2;
export const PROJECT_SLUG_MAX = 48;

/** Tabela transliteracji 1:1 (znak źródłowy → ASCII), identyczna z argumentami `translate()` w SQL
 * backfillu. Polskie litery + popularne łacińskie diakrytyki; wielkie litery jawnie (SQL
 * `translate` biegnie PRZED `lower()`, więc nie zależy od locale bazy). Formy NFC (pojedynczy
 * code point) — żadnych duplikatów w `TRANSLIT_FROM`. */
export const TRANSLIT_FROM =
  'ąáàâäãåćčçďęéèêëěíìîïłľĺńňñóôöõőřŕśšťúùûüůűýÿźżžĄÁÀÂÄÃÅĆČÇĎĘÉÈÊËĚÍÌÎÏŁĽĹŃŇÑÓÔÖÕŐŘŔŚŠŤÚÙÛÜŮŰÝŸŹŻŽ';
export const TRANSLIT_TO =
  'aaaaaaacccdeeeeeeiiiilllnnnooooorrsstuuuuuuyyzzzAAAAAAACCCDEEEEEEIIIILLLNNNOOOOORRSSTUUUUUUYYZZZ';

const TRANSLIT_TO_CHARS = [...TRANSLIT_TO];
const TRANSLIT_MAP: ReadonlyMap<string, string> = new Map(
  [...TRANSLIT_FROM].map((ch, i) => [ch, TRANSLIT_TO_CHARS[i]] as const),
);

function transliterate(input: string): string {
  let out = '';
  for (const ch of input) out += TRANSLIT_MAP.get(ch) ?? ch;
  return out;
}

function trimTrailingDash(s: string): string {
  return s.replace(/-+$/, '');
}

/** Trim + lowercase — wartość nagłówka `X-Context-Keeper-Project` i (w scope B) input
 * `create_project`; porównania slugów idą zawsze po tej normalizacji. */
export function normalizeProjectSlugInput(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidProjectSlug(slug: string): boolean {
  return slug.length >= PROJECT_SLUG_MIN && slug.length <= PROJECT_SLUG_MAX && PROJECT_SLUG_RE.test(slug);
}

/** Walidacja slugu podanego jawnie (CLI/dashboard/`create_project`) — `validation_error` z
 * czytelnym opisem reguły. Zakłada wejście już znormalizowane (`normalizeProjectSlugInput`). */
export function assertValidProjectSlug(slug: string): void {
  if (!isValidProjectSlug(slug)) {
    throw new ToolError(
      'validation_error',
      `Nieprawidłowy slug projektu "${slug}" — dozwolone: małe litery a–z, cyfry i pojedyncze myślniki ` +
        `między segmentami (${PROJECT_SLUG_RE.source}), ${PROJECT_SLUG_MIN}–${PROJECT_SLUG_MAX} znaków.`,
    );
  }
}

/** Slug wyprowadzony z nazwy: transliteracja → ASCII lowercase → ciągi znaków spoza `[a-z0-9]` na
 * jeden `-` → trim `-` → cięcie do 48 → trim końcowego `-`. `''` gdy wynik krótszy niż 2 znaki
 * (wołający używa wtedy `fallbackSlug`). */
export function slugifyProjectName(name: string): string {
  const base = transliterate(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = trimTrailingDash(base.slice(0, PROJECT_SLUG_MAX));
  return cut.length < PROJECT_SLUG_MIN ? '' : cut;
}

/** Slug awaryjny gdy nazwa nie daje nic sensownego: `project-<końcówka id>` (tylko `[a-z0-9]`),
 * `'project'` gdy końcówka pusta. */
export function fallbackSlug(projectId: string): string {
  const tail = projectId
    .replace(/^proj_/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const raw = tail ? `project-${tail}` : 'project';
  return trimTrailingDash(raw.slice(0, PROJECT_SLUG_MAX));
}

/** Kandydat kolizyjny `<base>-<n>` mieszczący się w 48 znakach (baza obcinana, nie sufiks). */
export function withCollisionSuffix(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${trimTrailingDash(base.slice(0, PROJECT_SLUG_MAX - suffix.length))}${suffix}`;
}
