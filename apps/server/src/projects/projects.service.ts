import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { generateId, ID_PREFIX } from '../common/ids';
import { generateToken, hashToken, isValidTokenFormat } from '../common/tokens';
import { DB, type Database } from '../db/db.tokens';
import { projects, type ProjectRow } from '../db/schema';

/** Kontekst projektu wyprowadzony z bearer tokena (dołączany do requestu przez BearerGuard). */
export interface ProjectContext {
  projectId: string;
  projectName: string;
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
