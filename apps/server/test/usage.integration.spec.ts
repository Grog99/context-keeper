import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId, ID_PREFIX } from '../src/common/ids';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import { proposals, searchEvents, type NewProposalRow } from '../src/db/schema';
import type { ProjectContext } from '../src/projects/projects.service';
import { ProjectsService } from '../src/projects/projects.service';
import { UsageService } from '../src/usage/usage.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

/** Odpowiednik `daysAgo`, ale wyrównane do początku dnia UTC — `date_trunc('day', …)` bucketuje po
 * UTC, więc bez wyrównania test byłby kruchy w zależności o której godzinie realnie się wykonuje. */
function utcDayStart(daysBack: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - daysBack * DAY_MS);
}

async function insertSearchEvent(
  db: Database,
  input: { projectId: string; resultCount: number; degraded?: boolean; createdAt: Date },
): Promise<void> {
  await db.insert(searchEvents).values({
    id: generateId(ID_PREFIX.searchEvent),
    projectId: input.projectId,
    resultCount: input.resultCount,
    degraded: input.degraded ?? false,
    createdAt: input.createdAt,
  });
}

async function insertProposal(
  db: Database,
  input: Partial<NewProposalRow> & { projectId: string; updatedAt: Date },
): Promise<void> {
  await db.insert(proposals).values({
    id: generateId(ID_PREFIX.proposal),
    type: 'create',
    origin: 'agent',
    status: 'pending',
    payload: {},
    affectedIds: [],
    baseVersions: {},
    scope: 'project',
    ...input,
  });
}

describe('UsageService (integration, testcontainers) — ekran "Pomiary", roadmap v1.1', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let usage: UsageService;

  let projectA: ProjectContext;
  let projectB: ProjectContext;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });

    projects = new ProjectsService(db);
    usage = new UsageService(db);

    const createdA = await projects.createProject('usage-test-a');
    projectA = { projectId: createdA.project.id, projectName: createdA.project.name };
    const createdB = await projects.createProject('usage-test-b');
    projectB = { projectId: createdB.project.id, projectName: createdB.project.name };
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('recordSearch', () => {
    it('wstawia jeden wiersz search_events z podanymi polami, id zaczyna się od sev_', async () => {
      await usage.recordSearch({ projectId: projectA.projectId, resultCount: 3, degraded: false });

      const rows = await db.select().from(searchEvents).where(eq(searchEvents.projectId, projectA.projectId));
      const inserted = rows.find((r) => r.resultCount === 3 && !r.degraded);
      expect(inserted).toBeDefined();
      expect(inserted!.id).toMatch(/^sev_/);
    });
  });

  describe('searchSeries — bucketing per projekt, zero-result WYŁĄCZA degraded', () => {
    it('grupuje po (projekt, dzień) i liczy searches/zeroResult/degraded poprawnie', async () => {
      const created = await projects.createProject('usage-series-day-a');
      const pA = created.project.id;
      const createdB = await projects.createProject('usage-series-day-b');
      const pB = createdB.project.id;

      const day0 = utcDayStart(0);
      const day1 = utcDayStart(1);

      // projektA / day1: 2 trafienia, 1 zero-result "prawdziwy", 1 zero-result ale degraded (WYŁĄCZONY
      // z liczby zero-result, ale wliczony do `searches` i do `degraded`).
      await insertSearchEvent(db, { projectId: pA, resultCount: 5, createdAt: new Date(day1.getTime() + HOUR_MS) });
      await insertSearchEvent(db, { projectId: pA, resultCount: 2, createdAt: new Date(day1.getTime() + 2 * HOUR_MS) });
      await insertSearchEvent(db, { projectId: pA, resultCount: 0, createdAt: new Date(day1.getTime() + 3 * HOUR_MS) });
      await insertSearchEvent(db, {
        projectId: pA,
        resultCount: 0,
        degraded: true,
        createdAt: new Date(day1.getTime() + 4 * HOUR_MS),
      });

      // projektB / day0: 1 trafienie.
      await insertSearchEvent(db, { projectId: pB, resultCount: 1, createdAt: new Date(day0.getTime() + HOUR_MS) });

      const rows = await usage.searchSeries({
        from: new Date(day1.getTime() - HOUR_MS),
        to: new Date(day0.getTime() + DAY_MS),
        bucket: 'day',
      });

      const aRow = rows.find((r) => r.projectId === pA);
      expect(aRow).toBeDefined();
      expect(aRow!.searches).toBe(4);
      expect(aRow!.zeroResult).toBe(1); // NIE 2 — degraded wyłączony
      expect(aRow!.degraded).toBe(1);
      expect(aRow!.ts.getTime()).toBe(day1.getTime());

      const bRow = rows.find((r) => r.projectId === pB);
      expect(bRow).toBeDefined();
      expect(bRow!.searches).toBe(1);
      expect(bRow!.zeroResult).toBe(0);
      expect(bRow!.degraded).toBe(0);

      // Uporządkowane rosnąco po ts: day0 (projektB) przed day1 (projektA).
      const tsOrder = rows.map((r) => r.ts.getTime());
      expect([...tsOrder].sort((x, y) => x - y)).toEqual(tsOrder);
    });

    it('filtr projectId zawęża wynik do jednego projektu', async () => {
      const created = await projects.createProject('usage-series-filter');
      const pOther = created.project.id;
      const now = new Date();
      await insertSearchEvent(db, { projectId: projectA.projectId, resultCount: 1, createdAt: now });
      await insertSearchEvent(db, { projectId: pOther, resultCount: 1, createdAt: now });

      const rows = await usage.searchSeries({
        from: new Date(now.getTime() - HOUR_MS),
        to: new Date(now.getTime() + HOUR_MS),
        bucket: 'day',
        projectId: pOther,
      });

      expect(rows.every((r) => r.projectId === pOther)).toBe(true);
      expect(rows.some((r) => r.projectId === projectA.projectId)).toBe(false);
    });

    it('bucket "hour" rozdziela wydarzenia z tej samej doby na osobne kubełki', async () => {
      const created = await projects.createProject('usage-series-hour');
      const pHour = created.project.id;
      const hourStart = new Date();
      hourStart.setUTCMinutes(0, 0, 0);

      await insertSearchEvent(db, { projectId: pHour, resultCount: 1, createdAt: hourStart });
      await insertSearchEvent(db, {
        projectId: pHour,
        resultCount: 1,
        createdAt: new Date(hourStart.getTime() + HOUR_MS),
      });

      const rows = await usage.searchSeries({
        from: new Date(hourStart.getTime() - HOUR_MS),
        to: new Date(hourStart.getTime() + 2 * HOUR_MS),
        bucket: 'hour',
      });

      const bucketsForProject = rows.filter((r) => r.projectId === pHour);
      expect(bucketsForProject.length).toBe(2);
    });
  });

  describe('proposalOutcomeSeries — źródło proposals, edit ⊆ accepted, withdrawn wyłączone', () => {
    it('liczy approved/rejected/approvedWithEdits per bucket, pomija pending i withdrawn', async () => {
      const created = await projects.createProject('usage-proposal-outcomes');
      const pOut = created.project.id;
      const day1 = utcDayStart(1);
      const ts = new Date(day1.getTime() + HOUR_MS);

      await insertProposal(db, { projectId: pOut, status: 'approved', editedPayload: null, updatedAt: ts });
      await insertProposal(db, {
        projectId: pOut,
        status: 'approved',
        editedPayload: { header: 'poprawione' },
        updatedAt: ts,
      });
      await insertProposal(db, { projectId: pOut, status: 'rejected', updatedAt: ts });
      await insertProposal(db, { projectId: pOut, status: 'withdrawn', updatedAt: ts });
      await insertProposal(db, { projectId: pOut, status: 'pending', updatedAt: ts });

      const rows = await usage.proposalOutcomeSeries({
        from: new Date(day1.getTime() - HOUR_MS),
        to: new Date(day1.getTime() + DAY_MS),
        bucket: 'day',
        projectId: pOut,
      });

      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.approved).toBe(2); // approved-bez-edycji + approved-z-edycją
      expect(row.approvedWithEdits).toBe(1); // PODZBIÓR approved, nie osobna trzecia kategoria
      expect(row.rejected).toBe(1);
      // withdrawn i pending NIE wchodzą do żadnej kolumny (suma approved+rejected != wszystkie 5 wierszy)
    });
  });

  describe('pruneOlderThan — retencja search_events', () => {
    it('usuwa TYLKO wiersze starsze niż cutoff, zwraca liczbę usuniętych', async () => {
      const created = await projects.createProject('usage-prune-test');
      const pPrune = created.project.id;

      await insertSearchEvent(db, { projectId: pPrune, resultCount: 1, createdAt: daysAgo(200) });
      await insertSearchEvent(db, { projectId: pPrune, resultCount: 1, createdAt: daysAgo(150) });
      await insertSearchEvent(db, { projectId: pPrune, resultCount: 1, createdAt: daysAgo(1) });

      const cutoff = daysAgo(90);
      const deletedCount = await usage.pruneOlderThan(cutoff);
      expect(deletedCount).toBeGreaterThanOrEqual(2); // co najmniej nasze 2 stare wiersze (200d, 150d)

      const remaining = await db.select().from(searchEvents).where(eq(searchEvents.projectId, pPrune));
      expect(remaining.length).toBe(1);
      expect(remaining[0].resultCount).toBe(1);
      expect(remaining[0].createdAt.getTime()).toBeGreaterThan(cutoff.getTime());
    });
  });
});
