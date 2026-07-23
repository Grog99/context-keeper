import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { generateId, ID_PREFIX } from '../common/ids';
import { generateToken, hashToken, isValidTokenFormat } from '../common/tokens';
import { DB, type Database } from '../db/db.tokens';
import { memories, projects, type ProjectRow } from '../db/schema';

/** Kontekst projektu wyprowadzony z bearer tokena (dołączany do requestu przez BearerGuard).
 * `includeEventsInDefaultSearch` opcjonalne (roadmap v1.2, "kind=event episodic") — żeby ręcznie
 * budowane `ProjectContext` w testach dalej się kompilowały bez tego pola; `undefined` ⇒ wyłączone
 * (patrz `MemoryService.search`). */
export interface ProjectContext {
  projectId: string;
  projectName: string;
  includeEventsInDefaultSearch?: boolean;
}

/** Wynik utworzenia/rotacji: pełny token `ck_…` widoczny TYLKO raz (w bazie zostaje hash). */
export interface CreatedProject {
  project: ProjectRow;
  token: string;
}

@Injectable()
export class ProjectsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async createProject(name: string): Promise<CreatedProject> {
    const token = generateToken();
    const [project] = await this.db
      .insert(projects)
      .values({
        id: generateId(ID_PREFIX.project),
        name,
        tokenHash: hashToken(token),
        tokenStatus: 'active',
      })
      .returning();
    return { project, token };
  }

  /** Rotacja hard-cutover (§10): nadpisuje token_hash → stary token przestaje działać natychmiast. */
  async rotateToken(projectId: string): Promise<CreatedProject> {
    const token = generateToken();
    const [project] = await this.db
      .update(projects)
      .set({
        tokenHash: hashToken(token),
        tokenStatus: 'active',
        tokenRotatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) {
      throw new NotFoundException(`Projekt nie istnieje: ${projectId}`);
    }
    return { project, token };
  }

  async listProjects(): Promise<ProjectRow[]> {
    return this.db.select().from(projects).orderBy(projects.createdAt);
  }

  /** Dialog szczegółów projektu (roadmap v1.2, "kind=event episodic") — dziś jedyne edytowalne pole
   * jest `includeEventsInDefaultSearch`; kontroler audytuje zmianę (`project_settings_changed`),
   * serwis sam nie audytuje (wzorem `createProject`/`rotateToken`, §M1 planu Fazy 5).
   * `updates.includeEventsInDefaultSearch === undefined` (pole pominięte w body) → no-op zwracający
   * bieżący wiersz, bez uderzania w `UPDATE` (`drizzle`'s `mapUpdateSet` rzuca "No values to set"
   * na pustym obiekcie `.set()`, więc filtrujemy `undefined` PRZED złożeniem zapytania). */
  async updateProject(
    projectId: string,
    updates: { includeEventsInDefaultSearch?: boolean },
  ): Promise<ProjectRow> {
    if (updates.includeEventsInDefaultSearch === undefined) {
      const current = await this.findById(projectId);
      if (!current) {
        throw new NotFoundException(`Projekt nie istnieje: ${projectId}`);
      }
      return current;
    }
    const [project] = await this.db
      .update(projects)
      .set({ includeEventsInDefaultSearch: updates.includeEventsInDefaultSearch })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) {
      throw new NotFoundException(`Projekt nie istnieje: ${projectId}`);
    }
    return project;
  }

  /** Liczba pamięci per projekt (§M1 planu Fazy 5, dashboard FR-D3) — jeden zagregowany zapytanie
   * zamiast N+1 per wiersz listy projektów. */
  async countMemoriesByProject(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ projectId: memories.projectId, count: sql<number>`count(*)::int` })
      .from(memories)
      .where(isNotNull(memories.projectId))
      .groupBy(memories.projectId);
    return new Map(rows.map((r) => [r.projectId as string, r.count]));
  }

  async findById(projectId: string): Promise<ProjectRow | null> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Lookup token → projekt (§10): jeden trafiony indeks po `token_hash` (SHA-256).
   * Bez constant-time compare (token wysokoentropijny, lookup indeksowany).
   */
  async resolveProjectByToken(token: string): Promise<ProjectRow | null> {
    if (!isValidTokenFormat(token)) return null;
    const [row] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.tokenHash, hashToken(token)))
      .limit(1);
    return row ?? null;
  }
}
