import { and, eq, or, type SQL } from 'drizzle-orm';
import { memories, type MemoryRow } from '../db/schema';

/**
 * Zakres ODCZYTU pamięci (roadmap v1.5, "Wyszukiwanie między projektami") — jedno źródło prawdy o
 * tym, które projekty widzą `search` i `get`. Dwie postacie tej samej reguły: warunek SQL
 * (`readScopeCondition`, oba ramiona search) i predykat wiersza (`isReadable`, `MemoryService.get`).
 *
 * - `project`      — pamięć `global` + pamięć projektu z kontekstu (zachowanie sprzed v1.5),
 * - `all_projects` — pamięć `global` + pamięć KAŻDEGO projektu instancji.
 *
 * CELOWO NIE używane przez gate'y zapisu (`supersedes`, `relations`): te zostają przy
 * `MemoryService.inScope` (ściśle projekt + global) — poszerzenie odczytu nie może otworzyć zapisu
 * na obce id (ticket `.tickets/cross-project-search.md`, ustalenie 9). Typ tokena zna wyłącznie
 * warstwa MCP (`mcp/read-scope-policy.ts`) — tu zakres przychodzi jako gotowa wartość.
 */
export type ReadScope = 'project' | 'all_projects';

/**
 * Warunek SQL zakresu odczytu, wspólny dla ramienia FTS i wektorowego (budowany raz w
 * `MemoryService.search`, więc tryb cross nie może zostać przełączony tylko w jednym ramieniu).
 *
 * `all_projects` = każdy wiersz `projects`: FK `memories.project_id -> projects` istnieje, a
 * `projects` nie ma kolumny statusu (projekt oczekujący to tylko propozycja, bez pamięci) — więc
 * `scope='project'` bez filtra `projectId` to dokładnie "wszystkie projekty". Przyszłe per-user auth
 * zawęża ten zbiór TUTAJ (np. `inArray(memories.projectId, allowedIds)`), w jednym miejscu.
 */
export function readScopeCondition(scope: ReadScope, projectId: string): SQL {
  const condition =
    scope === 'all_projects'
      ? or(eq(memories.scope, 'global'), eq(memories.scope, 'project'))
      : or(
          eq(memories.scope, 'global'),
          and(eq(memories.scope, 'project'), eq(memories.projectId, projectId)),
        );
  // `or()` z dwoma argumentami nigdy nie zwraca `undefined` — typ Drizzle jest tylko szerszy.
  return condition!;
}

/** Odpowiednik wierszowy `readScopeCondition` (ta sama semantyka) — dla `MemoryService.get`. */
export function isReadable(
  row: Pick<MemoryRow, 'scope' | 'projectId'>,
  scope: ReadScope,
  projectId: string,
): boolean {
  if (row.scope === 'global') return true;
  if (row.scope !== 'project') return false;
  return scope === 'all_projects' || row.projectId === projectId;
}
