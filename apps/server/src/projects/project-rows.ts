import { generateId, ID_PREFIX } from '../common/ids';
import type { Database, Tx } from '../db/db.tokens';
import { projects, type ProjectRow } from '../db/schema';
import { assertValidProjectSlug } from './slug';

/**
 * Wstawienie samego wiersza `projects` — BEZ tokena (roadmap v1.5, scope B, ticket #15). Wolna funkcja
 * (nie metoda `ProjectsService`), żeby `ProposalsService.approve()` (propozycja `create_project`)
 * tworzył projekt we własnej transakcji bez nowej zależności DI i bez cyklu modułów. Jedyna ścieżka
 * "projekt bez tokena"; `ProjectsService.createProject` woła ją i dokłada pierwszy token.
 *
 * Slug musi być już znormalizowany (`normalizeProjectSlugInput`) — tu tylko walidacja formatu.
 * Bez retry: kolizja (23505 na `projects_slug_key`) propaguje do wołającego, który wie, co z nią zrobić.
 */
export async function insertProject(
  executor: Database | Tx,
  input: { id?: string; name: string; slug: string },
): Promise<ProjectRow> {
  assertValidProjectSlug(input.slug);
  const [project] = await executor
    .insert(projects)
    .values({ id: input.id ?? generateId(ID_PREFIX.project), name: input.name, slug: input.slug })
    .returning();
  return project;
}
