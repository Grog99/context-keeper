import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { generateId, ID_PREFIX } from '../src/common/ids';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import {
  EMBEDDING_DIM,
  embeddings,
  memories,
  proposals,
  stagingEmbeddings,
  type MemoryRow,
  type ProposalRow,
} from '../src/db/schema';
import type { MemoryKind, MemoryScope } from '../src/db/schema/enums';
import { chunk } from '../src/embeddings/chunker';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { MemoryService } from '../src/memory/memory.service';
import type { ProjectContext, ProjectsService } from '../src/projects/projects.service';
import { ProposalsService } from '../src/proposals/proposals.service';
import { UsageService } from '../src/usage/usage.service';
import { buildProjectsService } from './helpers/services';

/** Wektor w płaszczyźnie osi (a, b) obróconej o kąt `t`: dystans kosinusowy do `vec(a, b, 0)` to
 * dokładnie `1 - cos t`, a do wektora z INNEJ pary osi — 1 (ortogonalne). */
function vec(a: number, b: number, t = 0): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[a] = Math.cos(t);
  v[b] = Math.sin(t);
  return v;
}

/** Kąt, dla którego `vec(a, b, kąt)` leży w zadanym dystansie kosinusowym od `vec(a, b, 0)`. */
function angleFor(distance: number): number {
  return Math.acos(1 - distance);
}

/** Wektor domyślny stuba: oś 1000 — ortogonalny do wszystkiego, czego używają testy (dystans 1). */
const FAR = vec(1000, 1001);

/** Stub providera z mapą tekst → wektor (nierejestrowane teksty dostają `FAR`), awarią i opóźnieniem. */
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;
  throwOnEmbed = false;
  delayMs = 0;
  private readonly known = new Map<string, number[]>();
  constructor(public model: string) {}

  register(text: string, vector: number[]): void {
    this.known.set(text, vector);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.throwOnEmbed) throw new Error('StubEmbeddingProvider: symulowana awaria providera');
    return texts.map((t) => this.known.get(t) ?? FAR);
  }

  async health(): Promise<boolean> {
    return !this.throwOnEmbed;
  }
}

/** Rejestruje wektory pod teksty chunków, które `MemoryService.save` faktycznie wyśle do providera
 * (prawdziwy `chunk()`), więc stub nie zgaduje formatu tekstu. */
function register(
  provider: StubEmbeddingProvider,
  content: { kind: MemoryKind; header: string; body: string },
  vectors: number[][],
): void {
  const chunks = chunk(content.kind, content.header, content.body, []);
  expect(chunks.length).toBe(vectors.length);
  chunks.forEach((c, i) => provider.register(c.text, vectors[i]));
}

const SAVE_BUDGET_MS = 10_000; // luz na zimny start testcontainera — funkcjonalne testy nie testują budżetu

describe('Detekcja prawie-duplikatów przy zapisie (A1, integration, testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let audit: AuditService;
  let counter = 0;

  function buildServices(
    provider: EmbeddingProvider,
    envOverrides: Record<string, unknown> = {},
  ): { memoryService: MemoryService; proposalsService: ProposalsService } {
    const config = new AppConfigService(
      envSchema.parse({
        DATABASE_URL: 'postgres://unused',
        NEAR_DUPLICATE_DISTANCE: 0.1,
        EMBEDDING_SAVE_TIMEOUT_MS: SAVE_BUDGET_MS,
        ...envOverrides,
      }),
    );
    const embeddingService = new EmbeddingService(provider, config);
    return {
      memoryService: new MemoryService(db, config, audit, embeddingService, new UsageService(db)),
      proposalsService: new ProposalsService(db, config, audit, embeddingService),
    };
  }

  /** Świeży projekt + unikalny model per test — testy nie widzą swoich pamięci ani wektorów. */
  async function freshCase(envOverrides: Record<string, unknown> = {}) {
    counter += 1;
    const created = await projects.createProject(`near-dup-${counter}`);
    const ctx: ProjectContext = { projectId: created.project.id, projectName: created.project.name };
    const provider = new StubEmbeddingProvider(`near-dup-model-${counter}`);
    return { ctx, provider, model: provider.model, ...buildServices(provider, envOverrides) };
  }

  /** Zatwierdzona pamięć z autorytatywnymi wektorami chunków (bezpośredni insert — bez providera). */
  async function seedApproved(p: {
    projectId: string | null;
    scope?: MemoryScope;
    kind?: MemoryKind;
    header: string;
    body: string;
    vectors: number[][];
    model: string;
  }): Promise<MemoryRow> {
    const kind = p.kind ?? 'fact';
    const [row] = await db
      .insert(memories)
      .values({
        id: generateId(ID_PREFIX.memory),
        header: p.header,
        body: p.body,
        kind,
        tags: [],
        scope: p.scope ?? 'project',
        projectId: p.scope === 'global' ? null : p.projectId,
        status: 'approved',
        source: 'human',
        version: 0,
        approvedAt: new Date(),
      })
      .returning();
    const chunks = chunk(kind, p.header, p.body, []);
    expect(chunks.length).toBe(p.vectors.length);
    await db.insert(embeddings).values(
      chunks.map((c, i) => ({
        id: generateId(ID_PREFIX.embedding),
        memoryId: row.id,
        chunkIndex: c.index,
        chunkText: c.text,
        embeddingModel: p.model,
        vector: p.vectors[i],
      })),
    );
    return row;
  }

  async function proposalForMemory(memoryId: string): Promise<ProposalRow> {
    const rows = await db.select().from(proposals);
    const match = rows.find((r) => (r.payload as { memoryId?: string }).memoryId === memoryId);
    if (!match) throw new Error(`Brak proposala dla memoryId=${memoryId}`);
    return match;
  }

  async function proposalCount(projectId: string): Promise<number> {
    return (await db.select().from(proposals).where(eq(proposals.projectId, projectId))).length;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    projects = buildProjectsService(db, new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' })));
    audit = new AuditService(db);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('fact — podstawowe stany (G1, G3)', () => {
    it('bliski zatwierdzony fakt tego samego projektu → pending + podpowiedź {id, distance}; kształt wyniku bez zmian (G11)', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      const a = await seedApproved({
        projectId: ctx.projectId,
        header: 'Fakt A',
        body: 'Klient używa PostgreSQL 15.',
        vectors: [vec(0, 1)],
        model,
      });
      register(provider, { kind: 'fact', header: 'Fakt A prim', body: 'Klient korzysta z PG 15.' }, [
        vec(0, 1, angleFor(0.02)),
      ]);

      const res = await memoryService.save({ header: 'Fakt A prim', body: 'Klient korzysta z PG 15.' }, ctx);

      expect(res.status).toBe('pending');
      expect(Object.keys(res).sort()).toEqual(['id', 'status']);
      const row = await proposalForMemory(res.id);
      expect(row.similarMemories).toHaveLength(1);
      expect(row.similarMemories![0].id).toBe(a.id);
      expect(row.similarMemories![0].distance).toBeCloseTo(0.02, 4);
    });

    it('tylko pamięć daleko → [] (policzono, brak podobnych), odróżnialne od NULL; hasSimilar=false', async () => {
      const { ctx, provider, model, memoryService, proposalsService } = await freshCase();
      await seedApproved({
        projectId: ctx.projectId,
        header: 'Daleki fakt',
        body: 'Zupełnie inny temat.',
        vectors: [vec(2, 3)],
        model,
      });
      register(provider, { kind: 'fact', header: 'Nowy fakt', body: 'O czymś innym.' }, [vec(0, 1)]);

      const res = await memoryService.save({ header: 'Nowy fakt', body: 'O czymś innym.' }, ctx);
      const row = await proposalForMemory(res.id);
      expect(row.similarMemories).toEqual([]);

      const page = await proposalsService.listPendingPage({ projectId: ctx.projectId });
      expect(page.items.find((i) => i.id === row.id)?.hasSimilar).toBe(false);
      const view = await proposalsService.getProposal(row.id);
      expect(view.similarMemories).toEqual([]);
    });

    it('provider rzuca → pending, proposal istnieje, similarMemories NULL, brak staging', async () => {
      const { ctx, provider, memoryService, proposalsService } = await freshCase();
      provider.throwOnEmbed = true;

      const res = await memoryService.save({ header: 'Awaria providera', body: 'Treść bez wektora.' }, ctx);

      expect(res.status).toBe('pending');
      const row = await proposalForMemory(res.id);
      expect(row.similarMemories).toBeNull();
      const staged = await db.select().from(stagingEmbeddings).where(eq(stagingEmbeddings.proposalId, row.id));
      expect(staged).toHaveLength(0);
      const view = await proposalsService.getProposal(row.id);
      expect(view.similarMemories).toBeNull();
      const page = await proposalsService.listPendingPage({ projectId: ctx.projectId });
      expect(page.items.find((i) => i.id === row.id)?.hasSimilar).toBe(false);
    });

    it('provider wolniejszy niż budżet (1000 ms vs 200 ms) → pending w budżecie, NULL', async () => {
      const { ctx, provider, memoryService } = await freshCase({ EMBEDDING_SAVE_TIMEOUT_MS: 200 });
      provider.delayMs = 1000;

      const startedAt = Date.now();
      const res = await memoryService.save({ header: 'Wolny provider', body: 'Treść czeka na wektor.' }, ctx);
      const elapsed = Date.now() - startedAt;

      expect(res.status).toBe('pending');
      expect(elapsed).toBeLessThan(800);
      const row = await proposalForMemory(res.id);
      expect(row.similarMemories).toBeNull();
    });
  });

  describe('idempotencja — exact-dedup bit-w-bit jak dotąd', () => {
    it('duplicate_pending → to samo id, bez nowego proposala, istniejąca podpowiedź nietknięta', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      const a = await seedApproved({
        projectId: ctx.projectId,
        header: 'Fakt bazowy',
        body: 'Baza dla duplicate_pending.',
        vectors: [vec(0, 1)],
        model,
      });
      register(provider, { kind: 'fact', header: 'Powtórka', body: 'Powtarzany zapis.' }, [vec(0, 1, angleFor(0.03))]);

      const first = await memoryService.save({ header: 'Powtórka', body: 'Powtarzany zapis.' }, ctx);
      const before = await proposalCount(ctx.projectId);
      const proposalBefore = await proposalForMemory(first.id);

      const second = await memoryService.save({ header: 'Powtórka', body: 'Powtarzany zapis.' }, ctx);

      expect(second).toEqual({ id: proposalBefore.id, status: 'duplicate_pending' });
      expect(await proposalCount(ctx.projectId)).toBe(before);
      const proposalAfter = await proposalForMemory(first.id);
      expect(proposalAfter.similarMemories).toEqual(proposalBefore.similarMemories);
      expect(proposalAfter.similarMemories![0].id).toBe(a.id);
    });

    it('already_exists → id pamięci, bez nowego proposala', async () => {
      const { ctx, model, memoryService } = await freshCase();
      const existing = await seedApproved({
        projectId: ctx.projectId,
        header: 'Istniejący',
        body: 'Dokładnie ta treść już jest.',
        vectors: [vec(0, 1)],
        model,
      });
      const before = await proposalCount(ctx.projectId);

      const res = await memoryService.save({ header: 'Istniejący', body: 'Dokładnie ta treść już jest.' }, ctx);

      expect(res).toEqual({ id: existing.id, status: 'already_exists' });
      expect(await proposalCount(ctx.projectId)).toBe(before);
    });
  });

  describe('granice porównania (G5-G7, ustalenia #5/#6)', () => {
    it('bliski fakt w INNYM projekcie → []', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      const other = await projects.createProject(`near-dup-other-${counter}`);
      await seedApproved({
        projectId: other.project.id,
        header: 'Cudzy fakt',
        body: 'Należy do innego projektu.',
        vectors: [vec(0, 1)],
        model,
      });
      register(provider, { kind: 'fact', header: 'Mój fakt', body: 'Podobny, ale mój.' }, [vec(0, 1, angleFor(0.01))]);

      const res = await memoryService.save({ header: 'Mój fakt', body: 'Podobny, ale mój.' }, ctx);
      expect((await proposalForMemory(res.id)).similarMemories).toEqual([]);
    });

    it('bliska pamięć INNEGO kind (document przy zapisie fact) → []', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      await seedApproved({
        projectId: ctx.projectId,
        kind: 'document',
        header: 'Dokument',
        body: 'Treść dokumentu.',
        vectors: [vec(0, 1)],
        model,
      });
      register(provider, { kind: 'fact', header: 'Fakt', body: 'Treść faktu.' }, [vec(0, 1, angleFor(0.01))]);

      const res = await memoryService.save({ header: 'Fakt', body: 'Treść faktu.' }, ctx);
      expect((await proposalForMemory(res.id)).similarMemories).toEqual([]);
    });

    it('bliski wektor INNEGO modelu → []', async () => {
      const { ctx, provider, memoryService } = await freshCase();
      await seedApproved({
        projectId: ctx.projectId,
        header: 'Stary model',
        body: 'Wektor policzony starym modelem.',
        vectors: [vec(0, 1)],
        model: 'zupelnie-inny-model',
      });
      register(provider, { kind: 'fact', header: 'Nowy model', body: 'Aktywny model.' }, [vec(0, 1, angleFor(0.01))]);

      const res = await memoryService.save({ header: 'Nowy model', body: 'Aktywny model.' }, ctx);
      expect((await proposalForMemory(res.id)).similarMemories).toEqual([]);
    });

    it('bliska zatwierdzona pamięć global → w podpowiedzi (G7)', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      const g = await seedApproved({
        projectId: null,
        scope: 'global',
        header: 'Globalny fakt',
        body: 'Obowiązuje wszędzie.',
        vectors: [vec(0, 1)],
        model,
      });
      register(provider, { kind: 'fact', header: 'Projektowy', body: 'Przypomina globalny.' }, [
        vec(0, 1, angleFor(0.02)),
      ]);

      const res = await memoryService.save({ header: 'Projektowy', body: 'Przypomina globalny.' }, ctx);
      const row = await proposalForMemory(res.id);
      expect(row.similarMemories?.map((h) => h.id)).toEqual([g.id]);
    });

    it('bliski tylko PENDING proposal (niezatwierdzony) → [] (G6)', async () => {
      const { ctx, provider, memoryService } = await freshCase();
      register(provider, { kind: 'fact', header: 'Pierwszy', body: 'Czeka w kolejce.' }, [vec(0, 1)]);
      register(provider, { kind: 'fact', header: 'Drugi', body: 'Bliźniak pending.' }, [vec(0, 1, angleFor(0.01))]);

      await memoryService.save({ header: 'Pierwszy', body: 'Czeka w kolejce.' }, ctx);
      const res = await memoryService.save({ header: 'Drugi', body: 'Bliźniak pending.' }, ctx);

      expect((await proposalForMemory(res.id)).similarMemories).toEqual([]);
    });
  });

  describe('limit, kolejność, próg (ustalenie #9, G8)', () => {
    it('4 bliskie (0.01-0.04) + jedna w 0.2 → dokładnie 3, rosnąco po odległości', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      const seeded: MemoryRow[] = [];
      // Kolejność wstawienia celowo przemieszana — wynik ma być posortowany po dystansie, nie po id/czasie.
      for (const [i, d] of [0.03, 0.01, 0.2, 0.04, 0.02].entries()) {
        seeded.push(
          await seedApproved({
            projectId: ctx.projectId,
            header: `Sąsiad ${i}`,
            body: `Sąsiad o dystansie ${d}.`,
            vectors: [vec(0, 1, angleFor(d))],
            model,
          }),
        );
      }
      register(provider, { kind: 'fact', header: 'Zapytanie', body: 'Punkt odniesienia.' }, [vec(0, 1)]);

      const res = await memoryService.save({ header: 'Zapytanie', body: 'Punkt odniesienia.' }, ctx);
      const hits = (await proposalForMemory(res.id)).similarMemories!;

      expect(hits).toHaveLength(3);
      expect(hits.map((h) => h.id)).toEqual([seeded[1].id, seeded[4].id, seeded[0].id]); // 0.01, 0.02, 0.03
      expect(hits.map((h) => h.distance)).toEqual([...hits.map((h) => h.distance)].sort((x, y) => x - y));
    });

    it('próg: dystans 0.05 wchodzi, 0.15 nie (NEAR_DUPLICATE_DISTANCE=0.1)', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      const near = await seedApproved({
        projectId: ctx.projectId,
        header: 'Blisko progu',
        body: 'Poniżej progu.',
        vectors: [vec(0, 1, angleFor(0.05))],
        model,
      });
      await seedApproved({
        projectId: ctx.projectId,
        header: 'Za progiem',
        body: 'Powyżej progu.',
        vectors: [vec(0, 1, angleFor(0.15))],
        model,
      });
      register(provider, { kind: 'fact', header: 'Próg', body: 'Sprawdzenie progu.' }, [vec(0, 1)]);

      const res = await memoryService.save({ header: 'Próg', body: 'Sprawdzenie progu.' }, ctx);
      expect((await proposalForMemory(res.id)).similarMemories?.map((h) => h.id)).toEqual([near.id]);
    });

    it('NIGHTLY_DEDUP_DISTANCE=0.001 nie wpływa na podpowiedź (G8)', async () => {
      const { ctx, provider, model, memoryService } = await freshCase({ NIGHTLY_DEDUP_DISTANCE: 0.001 });
      const a = await seedApproved({
        projectId: ctx.projectId,
        header: 'Nocny próg',
        body: 'Niezależność progów.',
        vectors: [vec(0, 1)],
        model,
      });
      register(provider, { kind: 'fact', header: 'Nocny próg 2', body: 'Niezależność progów 2.' }, [
        vec(0, 1, angleFor(0.02)),
      ]);

      const res = await memoryService.save({ header: 'Nocny próg 2', body: 'Niezależność progów 2.' }, ctx);
      expect((await proposalForMemory(res.id)).similarMemories?.map((h) => h.id)).toEqual([a.id]);
    });
  });

  describe('kind / typ propozycji (G3-G5)', () => {
    it('kind=event przy bliskim zatwierdzonym evencie → NULL, staging nadal zapisany (G4)', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      await seedApproved({
        projectId: ctx.projectId,
        kind: 'event',
        header: 'Deploy',
        body: 'Wdrożono wersję 1.',
        vectors: [vec(0, 1)],
        model,
      });
      register(provider, { kind: 'event', header: 'Deploy 2', body: 'Wdrożono wersję 2.' }, [
        vec(0, 1, angleFor(0.01)),
      ]);

      const res = await memoryService.save(
        { header: 'Deploy 2', body: 'Wdrożono wersję 2.', kind: 'event', eventTime: '2026-10-01T10:00:00Z' },
        ctx,
      );
      const row = await proposalForMemory(res.id);
      expect(row.similarMemories).toBeNull();
      const staged = await db.select().from(stagingEmbeddings).where(eq(stagingEmbeddings.proposalId, row.id));
      expect(staged.length).toBeGreaterThan(0);
    });

    it('supersedes (type=update) przy wektorze bliskim celu → NULL (G3)', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      const target = await seedApproved({
        projectId: ctx.projectId,
        header: 'Cel korekty',
        body: 'Stara wersja treści.',
        vectors: [vec(0, 1)],
        model,
      });
      register(provider, { kind: 'fact', header: 'Cel korekty', body: 'Nowa wersja treści.' }, [
        vec(0, 1, angleFor(0.01)),
      ]);

      const res = await memoryService.save(
        { header: 'Cel korekty', body: 'Nowa wersja treści.', supersedes: target.id },
        ctx,
      );
      expect(res.status).toBe('pending');
      const [row] = await db.select().from(proposals).where(eq(proposals.id, res.id));
      expect(row.type).toBe('update');
      expect(row.similarMemories).toBeNull();
    });

    it('dokument: chunki bliskie 2. i 3. chunkowi tego samego zatwierdzonego dokumentu → jedna pozycja, minimum dystansu (G5)', async () => {
      const { ctx, provider, model, memoryService } = await freshCase();
      const body = (tag: string) => `# Sekcja A\nTreść A ${tag}.\n# Sekcja B\nTreść B ${tag}.\n# Sekcja C\nTreść C ${tag}.`;
      const doc = await seedApproved({
        projectId: ctx.projectId,
        kind: 'document',
        header: 'Dokument bazowy',
        body: body('stary'),
        vectors: [vec(0, 1), vec(2, 3), vec(4, 5)],
        model,
      });
      register(provider, { kind: 'document', header: 'Dokument bazowy v2', body: body('nowy') }, [
        vec(20, 21), // chunk 0 — daleko od wszystkiego
        vec(2, 3, angleFor(0.03)), // chunk 1 ~ 2. chunk dokumentu bazowego
        vec(4, 5, angleFor(0.01)), // chunk 2 ~ 3. chunk dokumentu bazowego (minimum)
      ]);

      const res = await memoryService.save(
        { header: 'Dokument bazowy v2', body: body('nowy'), kind: 'document' },
        ctx,
      );
      const hits = (await proposalForMemory(res.id)).similarMemories!;
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe(doc.id);
      expect(hits[0].distance).toBeCloseTo(0.01, 4);
    });
  });

  describe('odczyt (ProposalsService) i cykl życia podpowiedzi', () => {
    /** Zapis z jedną bliską zatwierdzoną pamięcią A — wspólny punkt wyjścia testów odczytu. */
    async function saveWithOneHint() {
      const c = await freshCase();
      const a = await seedApproved({
        projectId: c.ctx.projectId,
        header: 'Pamięć A',
        body: 'Treść pamięci A.',
        vectors: [vec(0, 1)],
        model: c.model,
      });
      register(c.provider, { kind: 'fact', header: 'Zapis B', body: 'Treść zapisu B.' }, [vec(0, 1, angleFor(0.02))]);
      const res = await c.memoryService.save({ header: 'Zapis B', body: 'Treść zapisu B.' }, c.ctx);
      return { ...c, a, proposal: await proposalForMemory(res.id) };
    }

    it('getProposal: similarMemories[0] available + header + scope; listPendingPage: hasSimilar=true', async () => {
      const { ctx, a, proposal, proposalsService } = await saveWithOneHint();

      const view = await proposalsService.getProposal(proposal.id);
      expect(view.similarMemories).toHaveLength(1);
      expect(view.similarMemories![0]).toMatchObject({
        id: a.id,
        available: true,
        header: 'Pamięć A',
        scope: 'project',
      });

      const page = await proposalsService.listPendingPage({ projectId: ctx.projectId });
      expect(page.items.find((i) => i.id === proposal.id)?.hasSimilar).toBe(true);
    });

    it('edit-before-approve nie zmienia podpowiedzi (G2)', async () => {
      const { proposal, proposalsService } = await saveWithOneHint();

      await proposalsService.edit(proposal.id, { header: 'Zapis B (poprawiony)' }, { actor: 'tester' });

      const [after] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
      expect(after.editedPayload).not.toBeNull();
      expect(after.similarMemories).toEqual(proposal.similarMemories);
    });

    it('A zarchiwizowana po zapisie → available:false, header:null, hasSimilar=false, bez wyjątku', async () => {
      const { ctx, a, proposal, proposalsService } = await saveWithOneHint();
      await db.update(memories).set({ status: 'archived' }).where(eq(memories.id, a.id));

      const view = await proposalsService.getProposal(proposal.id);
      expect(view.similarMemories).toEqual([
        { id: a.id, distance: proposal.similarMemories![0].distance, available: false, header: null, scope: null },
      ]);
      const page = await proposalsService.listPendingPage({ projectId: ctx.projectId });
      expect(page.items.find((i) => i.id === proposal.id)?.hasSimilar).toBe(false);
    });

    it('wiersz A usunięty po zapisie → available:false, hasSimilar=false, bez wyjątku', async () => {
      const { ctx, a, proposal, proposalsService } = await saveWithOneHint();
      await db.delete(embeddings).where(eq(embeddings.memoryId, a.id));
      await db.delete(memories).where(and(eq(memories.id, a.id)));

      const view = await proposalsService.getProposal(proposal.id);
      expect(view.similarMemories).toEqual([
        { id: a.id, distance: proposal.similarMemories![0].distance, available: false, header: null, scope: null },
      ]);
      const page = await proposalsService.listPendingPage({ projectId: ctx.projectId });
      expect(page.items.find((i) => i.id === proposal.id)?.hasSimilar).toBe(false);
    });
  });
});
