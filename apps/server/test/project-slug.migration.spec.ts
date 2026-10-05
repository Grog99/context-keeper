import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidProjectSlug } from '../src/projects/slug';
import { assignSlugsLikeMigration, MIGRATION_SLUG_FIXTURES } from './helpers/project-slug-fixtures';

/**
 * Migracja 0012 (roadmap v1.5: slug projektu + nullable `project_tokens.project_id` + indeks etykiet
 * tokenów konta) na NIEPUSTEJ bazie: stan sprzed 0012 → projekty z brzydkimi/powtarzalnymi nazwami →
 * migracja → każdy dostaje unikalny, poprawny slug. Te same dane (`MIGRATION_SLUG_FIXTURES`) sprawdza
 * implementacja TS (`project-slug.spec.ts`), więc rozjazd SQL ↔ TS wywali któryś z testów.
 */
describe('migracja 0012 — backfill slugów na niepustej bazie (testcontainers)', () => {
  const REAL_FOLDER = resolve(process.cwd(), 'src/db/migrations');

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tmpFolder: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const db = drizzle(pool);

    // Katalog „sprzed 0012": pliki SQL wpisów 0000…0011 + journal obcięty do tych wpisów.
    tmpFolder = mkdtempSync(join(tmpdir(), 'ck-mig-pre0012-'));
    mkdirSync(join(tmpFolder, 'meta'));
    const journal = JSON.parse(readFileSync(join(REAL_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    // Liczba wpisów sprzed 0012 = indeks wpisu 0012_* w prawdziwym journalu (bez magicznej stałej).
    const idx0012 = journal.entries.findIndex((e) => e.tag.startsWith('0012_'));
    if (idx0012 < 0) throw new Error('Brak wpisu 0012_* w meta/_journal.json — test migracji 0012 nie ma czego sprawdzać.');
    const pre = journal.entries.slice(0, idx0012);
    for (const entry of pre) copyFileSync(join(REAL_FOLDER, `${entry.tag}.sql`), join(tmpFolder, `${entry.tag}.sql`));
    writeFileSync(join(tmpFolder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: pre }, null, 2));

    await migrate(db, { migrationsFolder: tmpFolder });

    // Stan przed 0012: `projects` jeszcze bez `slug`. created_at rosnące → deterministyczna kolejność backfillu.
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (const [i, fx] of MIGRATION_SLUG_FIXTURES.entries()) {
      await pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $2, $3)', [
        fx.id,
        fx.name,
        new Date(base + i * 60_000),
      ]);
    }

    // Prawdziwy katalog: migrator stosuje tylko wpisy z `when` > ostatnio zastosowanego → wyłącznie 0012.
    await migrate(db, { migrationsFolder: REAL_FOLDER });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (tmpFolder) rmSync(tmpFolder, { recursive: true, force: true });
  });

  it('każdy istniejący projekt dostaje oczekiwany slug (kolizje -2/-3, fallback project-<id>)', async () => {
    const { rows } = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM projects ORDER BY created_at');
    expect(rows.map((r) => r.slug)).toEqual(MIGRATION_SLUG_FIXTURES.map((f) => f.expected));
  });

  it('parytet SQL ↔ TS: implementacja TS daje te same slugi co backfill', async () => {
    const { rows } = await pool.query<{ id: string; name: string; slug: string }>(
      'SELECT id, name, slug FROM projects ORDER BY created_at',
    );
    expect(assignSlugsLikeMigration(rows)).toEqual(rows.map((r) => r.slug));
  });

  it('wszystkie slugi: poprawny format, 2–48 znaków, unikalne', async () => {
    const { rows } = await pool.query<{ slug: string }>('SELECT slug FROM projects');
    for (const { slug } of rows) expect(isValidProjectSlug(slug), slug).toBe(true);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
  });

  it('projects.slug jest NOT NULL, jest unikalny indeks i CHECK formatu', async () => {
    const col = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name='projects' AND column_name='slug'",
    );
    expect(col.rows[0].is_nullable).toBe('NO');

    const idx = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='projects_slug_key'");
    expect(idx.rowCount).toBe(1);
    expect(idx.rows[0].indexdef).toContain('UNIQUE');

    await expect(pool.query("UPDATE projects SET slug = 'Bad Slug' WHERE id = 'proj_a1'")).rejects.toMatchObject({
      constraint: 'projects_slug_format_check',
    });
    await expect(pool.query("UPDATE projects SET slug = 'my-project-2' WHERE id = 'proj_a1'")).rejects.toMatchObject({
      constraint: 'projects_slug_key',
    });
  });

  it('project_tokens.project_id jest nullable; partial unique na etykiecie tokenów konta istnieje', async () => {
    const col = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name='project_tokens' AND column_name='project_id'",
    );
    expect(col.rows[0].is_nullable).toBe('YES');

    const idx = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname='project_tokens_account_label_active_key'",
    );
    expect(idx.rowCount).toBe(1);
    expect(idx.rows[0].indexdef).toContain('UNIQUE');
    expect(idx.rows[0].indexdef).toContain('project_id IS NULL');
  });

  it('partial unique egzekwuje etykietę wśród aktywnych tokenów konta (i tylko tam)', async () => {
    const insert = (id: string, hash: string, label: string, status = 'active', projectId: string | null = null) =>
      pool.query('INSERT INTO project_tokens (id, project_id, token_hash, label, status) VALUES ($1, $2, $3, $4, $5)', [
        id,
        projectId,
        hash,
        label,
        status,
      ]);
    await insert('tok_acc1', 'h1', 'agent');
    await expect(insert('tok_acc2', 'h2', 'agent')).rejects.toMatchObject({
      constraint: 'project_tokens_account_label_active_key',
    });
    await insert('tok_acc3', 'h3', 'agent', 'revoked'); // nieaktywny nie koliduje
    await insert('tok_prj1', 'h4', 'agent', 'active', 'proj_a1'); // token projektowy — inny zakres
  });
});
