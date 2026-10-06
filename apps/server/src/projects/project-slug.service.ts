import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { ToolError, type ProjectSummary } from '../common/errors';
import { DB, type Database } from '../db/db.tokens';
import { projects, proposals, type ProjectRow } from '../db/schema';
import type { ProjectScopeLookups } from './project-scope';
import { fallbackSlug, slugifyProjectName, withCollisionSuffix } from './slug';

/**
 * Zapytania o slugi projektów (roadmap v1.5) — wydzielone z `ProjectsService`, żeby `BearerGuard`,
 * fabryka MCP i (w B) moduł onboardingu zależały od wąskiego serwisu zamiast od całego
 * `ProjectsService` (tokeny, rotacja…). Implementuje `ProjectScopeLookups`, więc przechodzi wprost
 * do czystego `resolveProjectScope`.
 */
@Injectable()
export class ProjectSlugService implements ProjectScopeLookups {
  constructor(@Inject(DB) private readonly db: Database) {}

  async findBySlug(slug: string): Promise<ProjectRow | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    return row ?? null;
  }

  /**
   * Czy slug czeka w oczekującej propozycji `create_project` (scope B). Payload trzyma slug
   * ZNORMALIZOWANY (trim + lowercase) — `ProjectProposalService.proposeProject` — dzięki temu ten
   * lookup i partial unique index `proposals_create_project_slug_pending_key` zgadzają się co do klucza.
   */
  async isSlugPending(slug: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.type, 'create_project'),
          eq(proposals.status, 'pending'),
          sql`${proposals.payload}->>'slug' = ${slug}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Slug wolny = nie trzyma go istniejący projekt (poza `excludeProjectId` — edycja własnego slugu)
   * ani oczekująca propozycja `create_project` (ticket #14, otwarty punkt: domyślnie blokujemy).
   * Wspólny check dla `createProject`, `create_project` (B) i edycji slugu (C) — `validation_error`.
   */
  async assertSlugAvailable(slug: string, opts?: { excludeProjectId?: string }): Promise<void> {
    const conditions = [eq(projects.slug, slug)];
    if (opts?.excludeProjectId) conditions.push(ne(projects.id, opts.excludeProjectId));
    const [existing] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(...conditions))
      .limit(1);
    if (existing) {
      throw new ToolError('validation_error', `Slug "${slug}" jest już zajęty przez istniejący projekt.`);
    }
    if (await this.isSlugPending(slug)) {
      throw new ToolError(
        'validation_error',
        `Slug "${slug}" jest zarezerwowany przez oczekującą propozycję create_project.`,
      );
    }
  }

  /** `[{slug, name}]` wszystkich projektów instancji (posortowane po slugu) — `details.projects` w
   * błędach `project_required`/`project_not_found` (wyłącznie dla tokenu konta). */
  async listProjectSummaries(): Promise<ProjectSummary[]> {
    return this.db.select({ slug: projects.slug, name: projects.name }).from(projects).orderBy(asc(projects.slug));
  }

  /** Pierwszy wolny slug dla nowego projektu: baza z nazwy (albo `project-<końcówka id>`), potem
   * `-2`, `-3`… — pre-check; ostateczną gwarancją jest unikalny indeks (retry w `createProject`). */
  async pickFreeSlug(name: string, projectId: string): Promise<string> {
    const base = slugifyProjectName(name) || fallbackSlug(projectId);
    let candidate = base;
    for (let n = 2; await this.isSlugTaken(candidate); n++) {
      candidate = withCollisionSuffix(base, n);
    }
    return candidate;
  }

  private async isSlugTaken(slug: string): Promise<boolean> {
    return (await this.findBySlug(slug)) !== null || (await this.isSlugPending(slug));
  }
}
