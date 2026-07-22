import 'reflect-metadata';
import { resolve } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { ToolError } from '../src/common/errors';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import { auditLog, EMBEDDING_DIM, embeddings, proposals, stagingEmbeddings } from '../src/db/schema';
import { generateId, ID_PREFIX } from '../src/common/ids';
import type { EmbeddingProvider } from '../src/embeddings/embedding-provider';
import { EmbeddingService } from '../src/embeddings/embedding.service';
import { MemoryService } from '../src/memory/memory.service';
import type { ProjectContext } from '../src/projects/projects.service';
import { ProjectsService } from '../src/projects/projects.service';

/**
 * Testcontainers nie potrafi odpalić prawdziwego sidecara TEI — port `EmbeddingProvider` istnieje
 * właśnie po to, żeby podstawić deterministyczny stub bez HTTP. `register` mapuje DOKŁADNY tekst
 * (np. treść query albo obliczony przez `chunk()` tekst chunku) na wektor; nieznany tekst dostaje
 * `fallback` (nigdy identyczny z jawnie zarejestrowanymi, żeby przypadkowo nie \"wygrał\" testu).
 */
class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;
  throwOnEmbed = false;
  private readonly vectors = new Map<string, number[]>();
  private readonly fallback = topicVector(0.9);

  constructor(public model: string) {}

  register(text: string, vector: number[]): void {
    this.vectors.set(text, vector);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.throwOnEmbed) {
      throw new Error('StubEmbeddingProvider: symulowana awaria providera');
    }
    return texts.map((t) => this.vectors.get(t) ?? this.fallback.slice());
  }

  async health(): Promise<boolean> {
    return !this.throwOnEmbed;
  }
}

/** Jednostkowy wektor z kontrolowanym cosine similarity do "query topic" = topicVector(1)
 * (component0 = cos_sim, bo query ma normę 1 i zero wszędzie poza indeksem 0). */
function topicVector(component0: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = component0;
  v[1] = Math.sqrt(Math.max(0, 1 - component0 * component0));
  return v;
}

describe('MemoryService (integration, testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let projects: ProjectsService;
  let memory: MemoryService;
  let audit: AuditService;
  let config: AppConfigService;

  let projectA: ProjectContext;
  let projectB: ProjectContext;

  /** Nowa (config, provider, memory service) trójka do testów, które potrzebują własnego stuba/env. */
  function buildMemoryService(
    provider: EmbeddingProvider,
    envOverrides: Record<string, unknown> = {},
  ): { memory: MemoryService; config: AppConfigService } {
    const cfg = new AppConfigService(
      envSchema.parse({ DATABASE_URL: 'postgres://unused', ...envOverrides }),
    );
    return { memory: new MemoryService(db, cfg, audit, new EmbeddingService(provider, cfg)), config: cfg };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });

    projects = new ProjectsService(db);
    audit = new AuditService(db);
    config = new AppConfigService(envSchema.parse({ DATABASE_URL: 'postgres://unused' }));
    // Provider "zawsze down" dla WSZYSTKICH istniejących (sprzed Fazy 3) testów poniżej — embedQuery
    // zawsze zwraca null, embedMemoryBestEffort zawsze null -> hybrid degeneruje się dokładnie do
    // starego zachowania FTS-only, więc te testy zostają nietknięte przez dodanie ramienia wektorowego.
    const downProvider = new StubEmbeddingProvider('down-stub');
    downProvider.throwOnEmbed = true;
    memory = new MemoryService(db, config, audit, new EmbeddingService(downProvider, config));

    const created = await projects.createProject('memory-test-a');
    projectA = { projectId: created.project.id, projectName: created.project.name };
    const createdB = await projects.createProject('memory-test-b');
    projectB = { projectId: createdB.project.id, projectName: createdB.project.name };
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('save — proposal + idempotencja (FR-M3, FR-M8)', () => {
    it('nowy zapis tworzy proposal pending, id zaczyna się od mem_', async () => {
      const res = await memory.save(
        { header: 'Pierwszy fakt', body: 'Treść pierwszego faktu.', tags: ['a'] },
        projectA,
      );
      expect(res.status).toBe('pending');
      expect(res.id).toMatch(/^mem_/);
    });

    it('proposal ma poprawny kształt: type=create, origin=agent, scope=project, payload z tagami', async () => {
      const res = await memory.save(
        { header: 'Fakt ze szczegółami', body: 'Treść ze szczegółami.', tags: ['x', 'Y'] },
        projectA,
      );
      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectA.projectId));
      const matching = rows.find((p) => (p.payload as { memoryId: string }).memoryId === res.id);

      expect(matching).toBeDefined();
      expect(matching!.type).toBe('create');
      expect(matching!.origin).toBe('agent');
      expect(matching!.status).toBe('pending');
      expect(matching!.scope).toBe('project');
      expect(matching!.projectId).toBe(projectA.projectId);
      expect(matching!.contentHash).toBeTruthy();
      const payload = matching!.payload as { header: string; body: string; tags: string[]; kind: string };
      expect(payload.header).toBe('Fakt ze szczegółami');
      expect(payload.tags).toEqual(['x', 'y']); // znormalizowane (lowercase)
      expect(payload.kind).toBe('fact');
    });

    it('duplicate_pending: identyczny save drugi raz zwraca id ISTNIEJĄCEGO proposala', async () => {
      const first = await memory.save(
        { header: 'Duplikat testowy', body: 'Ta sama treść.' },
        projectA,
      );
      expect(first.status).toBe('pending');

      const second = await memory.save(
        { header: 'Duplikat testowy', body: 'Ta sama treść.' },
        projectA,
      );
      expect(second.status).toBe('duplicate_pending');
      expect(second.id).not.toBe(first.id); // to id PROPOSALA, nie mintowanej pamięci
      expect(second.id).toMatch(/^prop_/);
    });

    it('already_exists: exact match do zatwierdzonej pamięci zwraca id PAMIĘCI', async () => {
      const seeded = await memory.devSeedApproved({
        header: 'Zatwierdzony fakt',
        body: 'Treść już zatwierdzona.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });

      const res = await memory.save(
        { header: 'Zatwierdzony fakt', body: 'Treść już zatwierdzona.' },
        projectA,
      );
      expect(res.status).toBe('already_exists');
      expect(res.id).toBe(seeded.id);
    });

    it('duplicate_pending jest per-projekt: ten sam header+body z INNEGO projektu tworzy NOWY proposal', async () => {
      const a = await memory.save({ header: 'Wspolny tekst', body: 'Identyczna tresc.' }, projectA);
      const b = await memory.save({ header: 'Wspolny tekst', body: 'Identyczna tresc.' }, projectB);
      expect(a.status).toBe('pending');
      expect(b.status).toBe('pending');
      expect(a.id).not.toBe(b.id);
    });

    it('secret_blocked: sekret w body blokuje zapis, audit log dostaje wpis BEZ materiału sekretu', async () => {
      const before = await db.select().from(proposals).where(eq(proposals.projectId, projectA.projectId));

      await expect(
        memory.save(
          { header: 'Konfiguracja AWS', body: 'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP' },
          projectA,
        ),
      ).rejects.toMatchObject({ code: 'secret_blocked' });

      const after = await db.select().from(proposals).where(eq(proposals.projectId, projectA.projectId));
      expect(after.length).toBe(before.length); // żaden proposal nie powstał

      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'secret_blocked'));
      expect(auditRows.length).toBeGreaterThan(0);
      const metadata = auditRows[auditRows.length - 1].metadata as { secretType: string };
      expect(metadata.secretType).toBe('aws_access_key');
      // Bez materiału sekretu w audycie:
      expect(JSON.stringify(auditRows[auditRows.length - 1])).not.toContain('AKIAABCDEFGHIJKLMNOP');
    });

    it('validation_error: header za długi, tag spoza charsetu, body za duże', async () => {
      await expect(
        memory.save({ header: 'a'.repeat(300), body: 'trescc' }, projectA),
      ).rejects.toMatchObject({ code: 'validation_error' });

      await expect(
        memory.save({ header: 'ok', body: 'tresc', tags: ['zly tag!'] }, projectA),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
  });

  describe('get — scope/IDOR (FR-M2, NFR-1, priorytet 2 wg §15)', () => {
    it('zwraca pełne body dla approved memory we własnym projekcie + bumpuje access_count', async () => {
      const seeded = await memory.devSeedApproved({
        header: 'Fakt do odczytu',
        body: 'Pełna treść do odczytu.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });

      const res1 = await memory.get(seeded.id, projectA);
      expect(res1.body).toBe('Pełna treść do odczytu.');
      expect(res1.accessCount).toBe(1);

      const res2 = await memory.get(seeded.id, projectA);
      expect(res2.accessCount).toBe(2);
    });

    it('cross-project -> not_found (IDOR)', async () => {
      const seeded = await memory.devSeedApproved({
        header: 'Fakt projektu A',
        body: 'Widoczny tylko w A.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });

      await expect(memory.get(seeded.id, projectB)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('nieistniejące id daje IDENTYCZNY błąd co cross-project (anty-probing)', async () => {
      let crossProjectErr: unknown;
      let missingErr: unknown;

      const seeded = await memory.devSeedApproved({
        header: 'Kolejny fakt A',
        body: 'Tresc.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });

      try {
        await memory.get(seeded.id, projectB);
      } catch (e) {
        crossProjectErr = e;
      }
      try {
        await memory.get('mem_doesnotexist0', projectB);
      } catch (e) {
        missingErr = e;
      }

      expect(crossProjectErr).toBeInstanceOf(ToolError);
      expect(missingErr).toBeInstanceOf(ToolError);
      expect((crossProjectErr as ToolError).code).toBe('not_found');
      expect((missingErr as ToolError).code).toBe('not_found');
    });

    it('global memory widoczna z KAŻDEGO projektu', async () => {
      const seeded = await memory.devSeedApproved({
        header: 'Fakt globalny',
        body: 'Widoczny wszędzie.',
        kind: 'fact',
        scope: 'global',
      });

      expect((await memory.get(seeded.id, projectA)).body).toBe('Widoczny wszędzie.');
      expect((await memory.get(seeded.id, projectB)).body).toBe('Widoczny wszędzie.');
    });

    it('archived memory -> not_found (nie jest approved)', async () => {
      const [archived] = await db
        .insert(schema.memories)
        .values({
          id: 'mem_archivedtest1',
          header: 'Zarchiwizowany fakt',
          body: 'Nie powinien być widoczny.',
          kind: 'fact',
          scope: 'project',
          projectId: projectA.projectId,
          status: 'archived',
          source: 'human',
        })
        .returning();

      await expect(memory.get(archived.id, projectA)).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('search — FTS na approved memories (FR-M1, FR-R1-R4, scope)', () => {
    it('znajduje seedowaną approved memory po tekście z headera/body', async () => {
      await memory.devSeedApproved({
        header: 'Konfiguracja PostgreSQL z pgvector',
        body: 'Uzywamy rozszerzenia pgvector oraz indeksu HNSW do wektorow.',
        kind: 'fact',
        tags: ['postgres', 'pgvector'],
        scope: 'project',
        projectId: projectA.projectId,
      });

      const results = await memory.search({ query: 'pgvector' }, projectA);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.header.includes('pgvector'))).toBe(true);
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('respektuje scope: memory innego projektu niewidoczna, global widoczna wszędzie', async () => {
      const marker = 'xylofon77unikalny';
      await memory.devSeedApproved({
        header: `Fakt prywatny projektu A ${marker}`,
        body: 'Tresc prywatna.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });
      await memory.devSeedApproved({
        header: `Fakt globalny ${marker}`,
        body: 'Tresc globalna.',
        kind: 'fact',
        scope: 'global',
      });

      const fromA = await memory.search({ query: marker }, projectA);
      const fromB = await memory.search({ query: marker }, projectB);

      expect(fromA.length).toBe(2); // prywatny A + globalny
      expect(fromB.length).toBe(1); // tylko globalny
      expect(fromB[0].header).toContain('globalny');
    });

    it('filtr kind zawęża wyniki', async () => {
      const marker = 'kindfiltermarker99';
      await memory.devSeedApproved({
        header: `Fakt ${marker}`,
        body: 'To jest fakt.',
        kind: 'fact',
        scope: 'project',
        projectId: projectA.projectId,
      });
      await memory.devSeedApproved({
        header: `Dokument ${marker}`,
        body: 'To jest dokument.',
        kind: 'document',
        scope: 'project',
        projectId: projectA.projectId,
      });

      const onlyFacts = await memory.search({ query: marker, kind: 'fact' }, projectA);
      const onlyDocs = await memory.search({ query: marker, kind: 'document' }, projectA);
      const both = await memory.search({ query: marker }, projectA);

      expect(onlyFacts.every((r) => r.header.startsWith('Fakt'))).toBe(true);
      expect(onlyDocs.every((r) => r.header.startsWith('Dokument'))).toBe(true);
      expect(both.length).toBe(onlyFacts.length + onlyDocs.length);
    });

    it('filtr tagów (any-of match) zawęża wyniki', async () => {
      const marker = 'tagfiltermarker42';
      await memory.devSeedApproved({
        header: `Z tagiem ${marker}`,
        body: 'Tresc.',
        kind: 'fact',
        tags: ['specialny-tag'],
        scope: 'project',
        projectId: projectA.projectId,
      });
      await memory.devSeedApproved({
        header: `Bez tagu ${marker}`,
        body: 'Tresc.',
        kind: 'fact',
        tags: ['inny-tag'],
        scope: 'project',
        projectId: projectA.projectId,
      });

      const tagged = await memory.search({ query: marker, tags: ['specialny-tag'] }, projectA);
      expect(tagged.length).toBe(1);
      expect(tagged[0].header).toContain('Z tagiem');
    });

    it('pusty wynik (brak dopasowań) to pusta lista, nie błąd', async () => {
      const results = await memory.search({ query: 'zupelnieniepowiazanafraza999xyz' }, projectA);
      expect(results).toEqual([]);
    });

    it('validation_error dla pustego query', async () => {
      await expect(memory.search({ query: '   ' }, projectA)).rejects.toMatchObject({
        code: 'validation_error',
      });
    });
  });

  describe('search — hybrid retrieval (Faza 3, FR-R2-R5)', () => {
    let projectH: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-hybrid');
      projectH = { projectId: created.project.id, projectName: created.project.name };
    });

    it('ramię wektorowe: trafienie WYŁĄCZNIE semantyczne (D) pojawia się w wynikach, mimo zera wspólnych tokenów z query', async () => {
      const provider = new StubEmbeddingProvider('hybrid-test-model');
      // SEARCH_VECTOR_CANDIDATES=2: dystraktor D (dist 0.5) zostaje w oknie kandydatów ramienia
      // wektorowego, ale F (dist 1, najdalszy) zostaje z niego wypchnięty. To SAMO w sobie NIE
      // wystarcza — RRF sumuje 1/(k+rank) po listach (przemienne), więc "S tylko w wektorze @rank1"
      // vs "F tylko w FTS @rank1" to ZAWSZE dokładny remis niezależnie od dowolnych innych
      // kandydatów. Żeby S deterministycznie wygrał, S musi też być obecny w ramieniu FTS (i to
      // jest realistyczne: dokument może jednocześnie pasować leksykalnie i semantycznie) —
      // S powtarza frazę zapytania (silniejszy ts_rank niż F, który ma ją raz), F zostaje CAŁKOWICIE
      // poza ramieniem wektorowym (dist 1 > oba inne kandydaty, wypchnięty przez limit=2).
      //
      // UNGAMEABLE CHECK: samo "S przed F" NIE dowodzi, że ramię wektorowe cokolwiek robi — S ma
      // dominujący ts_rank (fraza zapytania 2x: header+body) i wygrywa z F w RRF WYŁĄCZNIE dzięki
      // FTS, nawet gdyby ramię wektorowe zwróciło pustą listę (policzone: S=1/61≈0.01639 z samego
      // FTS vs F=1/62≈0.01613 — S i tak wygrywa). Dlatego właściwym dowodem, że ramię wektorowe
      // realnie kontrybuuje, jest obecność D w wynikach: D ma ZERO wspólnych tokenów z query (nie
      // matchuje `fts @@ tsquery` w ogóle, więc nigdy nie trafia do listy FTS), a jego jedyna droga
      // do `fused` to lista wektorowa (dist 0.5, rank 2 w oknie limit=2). Gdyby ramię wektorowe było
      // zepsute/puste, D nie miałby ŻADNEGO wkładu w żadnej liście -> w ogóle nie pojawiłby się w
      // `rrfFuse` -> asercja `ids).toContain(seededD.id)` poniżej by nie przeszła.
      const { memory: hybridMemory } = buildMemoryService(provider, { SEARCH_VECTOR_CANDIDATES: 2 });

      const query = 'usluga niedostepna hybrydtest01';
      provider.register(query, topicVector(1));

      // WAŻNE: wektor musi być zarejestrowany PRZED devSeedApproved — to ono woła embed() na
      // dokładnym tekście chunku i zapisuje zwrócony wektor do bazy. Rejestracja PO zapisie
      // spóźniłaby się (baza dostałaby wektor `fallback`, nie ten zamierzony).

      // S: fraza zapytania powtórzona (header + body) -> wysoki ts_rank; wektor IDENTYCZNY z query.
      const sHeader = 'usluga niedostepna hybrydtest01';
      const sBody = 'Usluga niedostepna hybrydtest01 — powtórnie odnotowana awaria w nocy.';
      provider.register(`${sHeader}\n\n${sBody}`, topicVector(1));
      const seededS = await hybridMemory.devSeedApproved({
        header: sHeader,
        body: sBody,
        kind: 'fact',
        scope: 'project',
        projectId: projectH.projectId,
      });

      // F: fraza zapytania obecna RAZ (słabszy ts_rank niż S), wektor ORTOGONALNY (semantycznie daleko).
      const fHeader = 'Zgloszenie serwisowe ABC789';
      const fBody = 'usluga niedostepna hybrydtest01 zgloszona przez klienta bez odpowiedzi.';
      provider.register(`${fHeader}\n\n${fBody}`, topicVector(0));
      const seededF = await hybridMemory.devSeedApproved({
        header: fHeader,
        body: fBody,
        kind: 'fact',
        scope: 'project',
        projectId: projectH.projectId,
      });

      // D: bez ŻADNYCH wspólnych tokenów z query (nie matchuje FTS w ogóle -> niemożliwy do znalezienia
      // przez ramię FTS), wektor W POŁOWIE drogi -> zajmuje rank 2 w oknie wektorowym (limit=2),
      // wypychając F (rank 3 pod względem dystansu) poza to okno. D jest jedynym memory w tym teście,
      // które ramię FTS nigdy nie zwróci — jego obecność w wynikach dowodzi ramienia wektorowego wprost.
      const dHeader = 'Notatka niepowiazana ABC789';
      const dBody = 'Calkowicie inny temat, bez zwiazku z zapytaniem.';
      provider.register(`${dHeader}\n\n${dBody}`, topicVector(0.5));
      const seededD = await hybridMemory.devSeedApproved({
        header: dHeader,
        body: dBody,
        kind: 'fact',
        scope: 'project',
        projectId: projectH.projectId,
      });

      const results = await hybridMemory.search({ query }, projectH);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(seededS.id);
      expect(ids).toContain(seededF.id);
      expect(ids.indexOf(seededS.id)).toBeLessThan(ids.indexOf(seededF.id));

      // Ungameable: D nie ma ŻADNYCH wspólnych tokenów z query, więc `fts @@ tsquery` nigdy go nie
      // zwróci — jedyna droga do wyników to ramię wektorowe. Gdyby ramię wektorowe zwracało puste
      // wyniki (lub w ogóle nie istniało), D nie miałoby wkładu w żadnej liście przekazanej do
      // `rrfFuse` i w ogóle by się nie pojawiło we `fused` — ta asercja nie przeszłaby.
      expect(ids).toContain(seededD.id);
    });

    it('fail-open: provider embeddingów rzuca -> search nie rzuca, wraca do wyniku FTS-only', async () => {
      const marker = 'failopenhybrydmarker77';
      await memory.devSeedApproved({
        header: `Fakt fail-open ${marker}`,
        body: 'Trescy do znalezienia przez FTS mimo padnietego providera.',
        kind: 'fact',
        scope: 'project',
        projectId: projectH.projectId,
      });

      const throwingProvider = new StubEmbeddingProvider('throwing-model');
      throwingProvider.throwOnEmbed = true;
      const { memory: throwingMemory } = buildMemoryService(throwingProvider);

      const results = await throwingMemory.search({ query: marker }, projectH);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.header.includes(marker))).toBe(true);
    });

    it('filtr aktywnego modelu (FR-R5): embedding pod STARYM modelem nie bierze udziału w ramieniu wektorowym', async () => {
      const [staleMemory] = await db
        .insert(schema.memories)
        .values({
          id: generateId(ID_PREFIX.memory),
          header: 'Fakt pod starym modelem modelfiltertest55',
          body: 'Tresc bez wspolnych tokenow z zapytaniem semantycznym.',
          kind: 'fact',
          tags: [],
          scope: 'project',
          projectId: projectH.projectId,
          status: 'approved',
          source: 'human',
          approvedAt: new Date(),
        })
        .returning();

      await db.insert(embeddings).values({
        id: generateId(ID_PREFIX.embedding),
        memoryId: staleMemory.id,
        chunkIndex: 0,
        chunkText: 'stary model — nieużywane w asercji',
        embeddingModel: 'model-old-stale',
        vector: topicVector(1),
      });

      const activeProvider = new StubEmbeddingProvider('model-active-new');
      const { memory: activeMemory } = buildMemoryService(activeProvider);

      // (1) Query semantycznie IDENTYCZNE do zapisanego (stale-model) wektora, ale ZERO wspólnych
      // tokenów z tresc/header -> gdyby filtr modelu nie działał, ramię wektorowe by to znalazło.
      const semanticQuery = 'zupelnieinnaFrazaModelTest999';
      activeProvider.register(semanticQuery, topicVector(1));
      const semanticResults = await activeMemory.search({ query: semanticQuery }, projectH);
      expect(semanticResults.some((r) => r.id === staleMemory.id)).toBe(false);

      // (2) Query z dokładnym tokenem z headera -> FTS wciąż znajduje, niezależnie od modelu wektora.
      const lexicalResults = await activeMemory.search({ query: 'modelfiltertest55' }, projectH);
      expect(lexicalResults.some((r) => r.id === staleMemory.id)).toBe(true);
    });
  });

  describe('save — staged embedding (Faza 3, best-effort fail-open)', () => {
    let projectS: ProjectContext;

    beforeAll(async () => {
      const created = await projects.createProject('memory-test-save-staging');
      projectS = { projectId: created.project.id, projectName: created.project.name };
    });

    async function proposalIdFor(memoryId: string, projectId: string): Promise<string> {
      const rows = await db.select().from(proposals).where(eq(proposals.projectId, projectId));
      const match = rows.find((p) => (p.payload as { memoryId: string }).memoryId === memoryId);
      if (!match) throw new Error(`Brak proposala dla memoryId=${memoryId}`);
      return match.id;
    }

    it('healthy provider: save zapisuje staging_embeddings dla nowego proposala', async () => {
      const healthyProvider = new StubEmbeddingProvider('save-staging-model');
      const { memory: healthyMemory } = buildMemoryService(healthyProvider);

      const res = await healthyMemory.save(
        { header: 'Fakt ze staged embeddingiem', body: 'Tresc do zaembeddowania przy save.' },
        projectS,
      );
      expect(res.status).toBe('pending');

      const propId = await proposalIdFor(res.id, projectS.projectId);
      const staged = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, propId));

      expect(staged.length).toBeGreaterThan(0);
      expect(staged[0].embeddingModel).toBe('save-staging-model');
      expect(staged[0].chunkText).toContain('Fakt ze staged embeddingiem');
    });

    it('provider down: save i tak tworzy proposal pending, ale BEZ wiersza staging_embeddings', async () => {
      const downProvider = new StubEmbeddingProvider('save-staging-down-model');
      downProvider.throwOnEmbed = true;
      const { memory: downMemory } = buildMemoryService(downProvider);

      const res = await downMemory.save(
        { header: 'Fakt bez staged embeddingu', body: 'Provider padniety przy tym save.' },
        projectS,
      );
      expect(res.status).toBe('pending');

      const propId = await proposalIdFor(res.id, projectS.projectId);
      const staged = await db
        .select()
        .from(stagingEmbeddings)
        .where(eq(stagingEmbeddings.proposalId, propId));
      expect(staged.length).toBe(0);
    });
  });
});
