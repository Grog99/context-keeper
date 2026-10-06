import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { ToolError } from '../src/common/errors';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import { auditLog, projects as projectsTable, proposals } from '../src/db/schema';
import { OnboardingService } from '../src/onboarding/onboarding.service';
import { ProjectProposalService } from '../src/onboarding/project-proposal.service';
import { ACCOUNT_ACTOR } from '../src/projects/project-scope';
import { ProjectSlugService } from '../src/projects/project-slug.service';
import type { TokenContext } from '../src/projects/projects.service';
import { buildProjectsService } from './helpers/services';

const ATTRIBUTION: TokenContext = { tokenId: 'tok_onboarding1', tokenLabel: 'acc-onboarding' };

describe('ProjectProposalService + OnboardingService (integration, testcontainers) — roadmap v1.5, scope B', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let slugs: ProjectSlugService;
  let onboarding: OnboardingService;
  let proposeService: ProjectProposalService;

  function build(envOverrides: Record<string, unknown> = {}) {
    const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused', ...envOverrides }));
    const onboardingService = new OnboardingService(config, slugs);
    return {
      onboardingService,
      proposeService: new ProjectProposalService(db, slugs, new AuditService(db), onboardingService),
    };
  }

  async function validationMessage(promise: Promise<unknown>): Promise<string> {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('validation_error');
    return (err as ToolError).message;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    slugs = new ProjectSlugService(db);
    ({ onboardingService: onboarding, proposeService } = build());
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('proposeProject', () => {
    it("normalizuje wejście (' My-Proj ' -> payload slug 'my-proj'), zapisuje propozycję globalną + audyt agent:account", async () => {
      const res = await proposeService.proposeProject({ name: '  My   Proj  ', slug: ' My-Proj ' }, ATTRIBUTION);

      expect(res.status).toBe('pending');
      expect(res.project).toEqual({ slug: 'my-proj', name: 'My Proj' });
      const [row] = await db.select().from(proposals).where(eq(proposals.id, res.proposalId));
      expect(row).toMatchObject({
        type: 'create_project',
        origin: 'agent',
        status: 'pending',
        scope: 'global',
        projectId: null,
        affectedIds: [],
        payload: { name: 'My Proj', slug: 'my-proj' },
      });
      // Projekt NIE istnieje przed approve.
      expect(await slugs.findBySlug('my-proj')).toBeNull();

      const [entry] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'proposal_created'))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      expect(entry).toMatchObject({
        actor: ACCOUNT_ACTOR,
        metadata: {
          proposalId: res.proposalId,
          type: 'create_project',
          slug: 'my-proj',
          name: 'My Proj',
          tokenId: ATTRIBUTION.tokenId,
          tokenLabel: ATTRIBUTION.tokenLabel,
        },
      });
    });

    it('niepoprawny slug -> validation_error (z regułą), brak propozycji', async () => {
      for (const slug of ['Not A Slug!', 'a', '-abc', 'a--b', 'x'.repeat(49), '']) {
        const msg = await validationMessage(proposeService.proposeProject({ name: 'Bad', slug }, ATTRIBUTION));
        expect(msg).toContain('Invalid project slug');
      }
      const rows = await db.select().from(proposals).where(eq(proposals.type, 'create_project'));
      expect(rows.some((r) => (r.payload as { name: string }).name === 'Bad')).toBe(false);
    });

    it('pusta nazwa -> validation_error', async () => {
      await validationMessage(proposeService.proposeProject({ name: '   ', slug: 'empty-name' }, ATTRIBUTION));
    });

    it('slug istniejącego projektu -> validation_error ("already exists")', async () => {
      await db.insert(projectsTable).values({ id: 'proj_onb_exists', name: 'Istniejący', slug: 'onb-exists' });
      const msg = await validationMessage(
        proposeService.proposeProject({ name: 'Inny', slug: 'ONB-Exists' }, ATTRIBUTION),
      );
      expect(msg).toContain('already exists');
      expect(msg).toContain('list_projects');
    });

    it('slug oczekującej propozycji -> validation_error ("awaiting approval")', async () => {
      await proposeService.proposeProject({ name: 'Pierwszy', slug: 'onb-pending' }, ATTRIBUTION);
      const msg = await validationMessage(
        proposeService.proposeProject({ name: 'Drugi', slug: 'onb-pending' }, ATTRIBUTION),
      );
      expect(msg).toContain('awaiting approval');
    });

    it('5 równoległych propozycji tego samego slugu: dokładnie 1 fulfilled, 4 validation_error (unikalny indeks)', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          proposeService.proposeProject({ name: `Race ${i}`, slug: 'onb-race' }, ATTRIBUTION),
        ),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(ToolError);
        expect((r.reason as ToolError).code).toBe('validation_error');
      }
      const rows = await db.select().from(proposals).where(eq(proposals.type, 'create_project'));
      expect(rows.filter((r) => (r.payload as { slug: string }).slug === 'onb-race')).toHaveLength(1);
    });

    it('sekret w nazwie -> secret_blocked + audyt secret_blocked (agent:account, bez materiału sekretu), brak propozycji', async () => {
      const secretName = 'Prod AKIAABCDEFGHIJKLMNOP';
      const err = await proposeService
        .proposeProject({ name: secretName, slug: 'onb-secret' }, ATTRIBUTION)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('secret_blocked');
      expect((err as ToolError).message).not.toContain('AKIAABCDEFGHIJKLMNOP');

      const rows = await db.select().from(proposals).where(eq(proposals.type, 'create_project'));
      expect(rows.some((r) => (r.payload as { slug: string }).slug === 'onb-secret')).toBe(false);
      const [entry] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'secret_blocked'))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      expect(entry.actor).toBe(ACCOUNT_ACTOR);
      expect(entry.metadata).toEqual({
        secretType: 'aws_access_key',
        tokenId: ATTRIBUTION.tokenId,
        tokenLabel: ATTRIBUTION.tokenLabel,
      });
      expect(JSON.stringify(entry)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    });

    it('zwrócone bloki: mcpJson z nagłówkiem = slug i placeholderem tokena; bez ck_; next opisuje project_pending', async () => {
      const res = await proposeService.proposeProject({ name: 'Blocks', slug: 'onb-blocks' }, ATTRIBUTION);
      const entry = (JSON.parse(res.mcpJson) as { mcpServers: Record<string, { headers: Record<string, string> }> })
        .mcpServers['context-keeper'];
      expect(entry.headers['X-Context-Keeper-Project']).toBe('onb-blocks');
      expect(entry.headers.Authorization).toBe('Bearer ${CONTEXT_KEEPER_TOKEN}');
      expect(JSON.stringify(res)).not.toMatch(/ck_[A-Za-z0-9_-]{20,}/);
      expect(res.next).toContain('project_pending');
      expect(res.agentsMd).toContain('search_memory');
    });
  });

  describe('OnboardingService', () => {
    it('mcpUrl: PUBLIC_MCP_URL > ACME_DOMAIN > placeholder (configured=false)', () => {
      expect(build({ PUBLIC_MCP_URL: 'https://ck.example.com' }).onboardingService.mcpUrl()).toEqual({
        url: 'https://ck.example.com/mcp',
        configured: true,
      });
      expect(build({ ACME_DOMAIN: 'ck.acme.test' }).onboardingService.mcpUrl()).toEqual({
        url: 'https://ck.acme.test/mcp',
        configured: true,
      });
      expect(onboarding.mcpUrl()).toEqual({ url: 'https://<your-mcp-host>/mcp', configured: false });
    });

    it('blocksFor == odpowiadający wpis listProjects (ten sam mcpJson, agentsMd, claudeMd)', async () => {
      await db.insert(projectsTable).values({ id: 'proj_onb_blocks', name: 'Blocks For', slug: 'onb-blocks-for' });
      const { onboardingService } = build({ PUBLIC_MCP_URL: 'https://ck.example.com' });
      const list = await onboardingService.listProjects();
      const entry = list.projects.find((p) => p.slug === 'onb-blocks-for');
      expect(entry).toBeDefined();

      const blocks = onboardingService.blocksFor({ slug: 'onb-blocks-for', name: 'Blocks For' });
      expect(blocks.mcpJson).toBe(entry!.mcpJson);
      expect(blocks.agentsMd).toBe(list.agentsMd);
      expect(blocks.claudeMd).toBe(list.claudeMd);
      expect(blocks.mcpUrlConfigured).toBe(true);
      expect(list.mcpUrlConfigured).toBe(true);
      expect(entry!.mcpJson).toContain('https://ck.example.com/mcp');
    });

    it('forDashboard: projects == listProjects().projects verbatim; wariant tokenu projektowego bez nagłówka; bez tokenów', async () => {
      const { onboardingService } = build({ PUBLIC_MCP_URL: 'https://ck.example.com' });
      // Token projektowy i token konta istnieją — odpowiedź i tak nie może zawierać żadnego ck_….
      const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
      const projectsService = buildProjectsService(db, config);
      const created = await projectsService.createProject('Dashboard Onboarding', { slug: 'onb-dashboard' });
      const account = await projectsService.createAccountToken('onb-dashboard-acc');

      const result = await onboardingService.forDashboard();
      const list = await onboardingService.listProjects();

      expect(result.projects).toEqual(list.projects);
      expect(result.projects.find((p) => p.slug === 'onb-dashboard')).toBeDefined();
      expect(result.agentsMd).toBe(list.agentsMd);
      expect(result.claudeMd).toBe(list.claudeMd);
      expect(result).toMatchObject({
        serverName: 'context-keeper',
        mcpUrl: 'https://ck.example.com/mcp',
        mcpUrlConfigured: true,
      });
      expect(result.projectTokenMcpJson).not.toContain('X-Context-Keeper-Project');
      expect(result.projectTokenMcpJson).toContain('${CONTEXT_KEEPER_TOKEN}');
      expect(result.projectTokenMcpJson).toContain('https://ck.example.com/mcp');
      expect(result).not.toHaveProperty('hint');

      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/ck_[A-Za-z0-9]/);
      expect(serialized).not.toContain(created.token);
      expect(serialized).not.toContain(account.token);
    });

    it('forDashboard: nieskonfigurowany URL -> placeholder + mcpUrlConfigured=false', async () => {
      const result = await onboarding.forDashboard();
      expect(result.mcpUrl).toBe('https://<your-mcp-host>/mcp');
      expect(result.mcpUrlConfigured).toBe(false);
    });

    it('listProjects: posortowane po slugu, hint wspomina placeholder URL gdy nieskonfigurowany', async () => {
      const list = await onboarding.listProjects();
      const listed = list.projects.map((p) => p.slug);
      expect(listed).toEqual([...listed].sort());
      expect(list.mcpUrlConfigured).toBe(false);
      expect(list.hint).toContain('<your-mcp-host>');
    });

    it('listProjects: puste projects + hint o create_project (świeża baza)', async () => {
      const fresh = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
      const freshPool = new Pool({ connectionString: fresh.getConnectionUri() });
      try {
        const freshDb = drizzle(freshPool, { schema });
        await migrate(freshDb, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
        const config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
        const list = await new OnboardingService(config, new ProjectSlugService(freshDb)).listProjects();
        expect(list.projects).toEqual([]);
        expect(list.hint).toContain('create_project');
        expect(list.agentsMd).toContain('Project binding');
      } finally {
        await freshPool.end();
        await fresh.stop();
      }
    });
  });
});
