import { fallbackSlug, slugifyProjectName, withCollisionSuffix } from '../../src/projects/slug';

/**
 * Wspólna tabela przypadków dla TS (`src/projects/slug.ts`) i SQL (backfill w migracji 0012) —
 * `project-slug.spec.ts` sprawdza TS, `project-slug.migration.spec.ts` sprawdza SQL na TYCH SAMYCH
 * danych, więc rozjazd transliteracji/kolizji między dwiema implementacjami wywali test.
 */

/** Czysta funkcja `name -> slug` (bez kolizji). `''` = wynik zbyt krótki → fallback. */
export const SLUGIFY_CASES: ReadonlyArray<readonly [name: string, expected: string]> = [
  ['Zażółć Gęślą Jaźń', 'zazolc-gesla-jazn'],
  ['My  Project!!', 'my-project'],
  ['!!!', ''],
  ['a', ''],
  ['mcp-e2e', 'mcp-e2e'],
  ['ŁÓDŹ Śląsk', 'lodz-slask'],
  ['Café Münster', 'cafe-munster'],
  // 47 × „a" + spacja + „b" → po cięciu do 48 kończy się myślnikiem, który ma zniknąć.
  [`${'a'.repeat(47)} b`, 'a'.repeat(47)],
  ['x'.repeat(70), 'x'.repeat(48)],
];

export interface MigrationSlugFixture {
  id: string;
  name: string;
  expected: string;
}

/** Wiersze `projects` w kolejności `created_at` (backfill idzie `ORDER BY created_at, id`) — kolizje
 * dostają sufiks `-2`, `-3`…; pusty wynik → `project-<końcówka id>`. */
export const MIGRATION_SLUG_FIXTURES: readonly MigrationSlugFixture[] = [
  { id: 'proj_a1', name: 'My Project', expected: 'my-project' },
  { id: 'proj_a2', name: 'my project', expected: 'my-project-2' },
  // Łańcuch kolizji: baza „my-project-2" jest już zajęta → „my-project-2-2".
  { id: 'proj_a3', name: 'My-Project-2', expected: 'my-project-2-2' },
  { id: 'proj_a4', name: '!!!', expected: 'project-a4' },
  { id: 'proj_a5', name: 'a', expected: 'project-a5' },
  { id: 'proj_a6', name: 'Zażółć Gęślą Jaźń', expected: 'zazolc-gesla-jazn' },
  { id: 'proj_a7', name: `${'a'.repeat(47)} b`, expected: 'a'.repeat(47) },
  { id: 'proj_a8', name: 'ŁÓDŹ Śląsk', expected: 'lodz-slask' },
  // Kolizja przy 47 znakach: sufiks „-2" wymusza obcięcie bazy do 46 → równo 48 znaków.
  { id: 'proj_a9', name: `${'a'.repeat(47)} b`, expected: `${'a'.repeat(46)}-2` },
  { id: 'proj_b0', name: 'Café Münster', expected: 'cafe-munster' },
];

/** Implementacja TS tego, co robi SQL-owy backfill — dla porównania z `expected` i z bazą. */
export function assignSlugsLikeMigration(rows: ReadonlyArray<{ id: string; name: string }>): string[] {
  const taken = new Set<string>();
  return rows.map(({ id, name }) => {
    const base = slugifyProjectName(name) || fallbackSlug(id);
    let candidate = base;
    let n = 1;
    while (taken.has(candidate)) {
      n += 1;
      candidate = withCollisionSuffix(base, n);
    }
    taken.add(candidate);
    return candidate;
  });
}
