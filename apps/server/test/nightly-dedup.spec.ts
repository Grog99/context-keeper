import { describe, expect, it } from 'vitest';
import { buildClusters, pickCanonicalMerge, type MergeCandidateInput } from '../src/nightly/dedup-cluster';

describe('buildClusters (Faza 6 — union-find nad parami near-identical)', () => {
  it('A-B i B-C łączą się w JEDEN klaster {A,B,C} (spójność przechodnia)', () => {
    const clusters = buildClusters([
      { a: 'mem_a', b: 'mem_b', dist: 0.01 },
      { a: 'mem_b', b: 'mem_c', dist: 0.02 },
    ]);
    expect(clusters).toEqual([['mem_a', 'mem_b', 'mem_c']]);
  });

  it('pary dwukierunkowe (A-B i B-A) dają DOKŁADNIE jeden klaster, nie dwa', () => {
    const clusters = buildClusters([
      { a: 'mem_a', b: 'mem_b', dist: 0.01 },
      { a: 'mem_b', b: 'mem_a', dist: 0.01 },
    ]);
    expect(clusters).toEqual([['mem_a', 'mem_b']]);
  });

  it('pojedynczy wierzchołek bez pary NIE tworzy klastra (rozmiar >= 2 wymagany)', () => {
    // Brak par w ogóle -> brak klastrów (nie ma nawet wierzchołków do rozważenia).
    expect(buildClusters([])).toEqual([]);
  });

  it('para "self" (a===b, teoretycznie niemożliwa z ANN wykluczającego siebie) nie tworzy klastra rozmiaru 1', () => {
    expect(buildClusters([{ a: 'mem_a', b: 'mem_a', dist: 0 }])).toEqual([]);
  });

  it('dwa rozłączne klastry zwrócone posortowane po pierwszym elemencie', () => {
    const clusters = buildClusters([
      { a: 'mem_z', b: 'mem_y', dist: 0.01 },
      { a: 'mem_b', b: 'mem_a', dist: 0.01 },
    ]);
    expect(clusters).toEqual([
      ['mem_a', 'mem_b'],
      ['mem_y', 'mem_z'],
    ]);
  });

  it('każdy zwrócony klaster jest posortowany rosnąco wewnętrznie, niezależnie od kolejności par wejściowych', () => {
    const clusters = buildClusters([
      { a: 'mem_c', b: 'mem_a', dist: 0.01 },
      { a: 'mem_c', b: 'mem_b', dist: 0.01 },
    ]);
    expect(clusters).toEqual([['mem_a', 'mem_b', 'mem_c']]);
  });

  it('deterministyczne: ten sam zbiór par (w innej kolejności) daje identyczny wynik', () => {
    const pairsOrderA = [
      { a: 'mem_a', b: 'mem_b', dist: 0.01 },
      { a: 'mem_c', b: 'mem_d', dist: 0.01 },
      { a: 'mem_b', b: 'mem_c', dist: 0.01 },
    ];
    const pairsOrderB = [pairsOrderA[2], pairsOrderA[0], pairsOrderA[1]];
    expect(buildClusters(pairsOrderA)).toEqual(buildClusters(pairsOrderB));
  });
});

describe('pickCanonicalMerge (Faza 6 — kanoniczna treść scalenia, deterministyczne, bez LLM)', () => {
  function candidate(overrides: Partial<MergeCandidateInput>): MergeCandidateInput {
    return {
      id: 'mem_x',
      header: 'H',
      body: 'B',
      tags: [],
      kind: 'fact',
      accessCount: 0,
      ...overrides,
    };
  }

  it('wybiera członka z najwyższym accessCount jako kanoniczny', () => {
    const payload = pickCanonicalMerge([
      candidate({ id: 'mem_a', header: 'A', body: 'A body', accessCount: 1 }),
      candidate({ id: 'mem_b', header: 'B', body: 'B body', accessCount: 5 }),
    ]);
    expect(payload.header).toBe('B');
    expect(payload.body).toBe('B body');
  });

  it('remis accessCount -> wygrywa najdłuższy body', () => {
    const payload = pickCanonicalMerge([
      candidate({ id: 'mem_a', header: 'A', body: 'short', accessCount: 2 }),
      candidate({ id: 'mem_b', header: 'B', body: 'a much longer body text', accessCount: 2 }),
    ]);
    expect(payload.header).toBe('B');
  });

  it('remis accessCount + body -> wygrywa najniższy id', () => {
    const payload = pickCanonicalMerge([
      candidate({ id: 'mem_zzz', header: 'Z', body: 'same', accessCount: 2 }),
      candidate({ id: 'mem_aaa', header: 'A', body: 'same', accessCount: 2 }),
    ]);
    expect(payload.header).toBe('A');
  });

  it('tagi = suma zbiorów wszystkich członków, zdeduplikowana i posortowana', () => {
    const payload = pickCanonicalMerge([
      candidate({ id: 'mem_a', tags: ['b', 'a'], accessCount: 1 }),
      candidate({ id: 'mem_b', tags: ['a', 'c'], accessCount: 0 }),
    ]);
    expect(payload.tags).toEqual(['a', 'b', 'c']);
  });

  it('mintuje nowy memoryId z prefiksem mem_ (nie reużywa id żadnego członka)', () => {
    const payload = pickCanonicalMerge([
      candidate({ id: 'mem_a', accessCount: 1 }),
      candidate({ id: 'mem_b', accessCount: 0 }),
    ]);
    expect(payload.memoryId).toMatch(/^mem_/);
    expect(payload.memoryId).not.toBe('mem_a');
    expect(payload.memoryId).not.toBe('mem_b');
  });

  it('klaster o rozmiarze < 2 rzuca błąd (wymaganie >= 2 członków)', () => {
    expect(() => pickCanonicalMerge([candidate({ id: 'mem_a' })])).toThrow();
  });

  it('klaster mieszający kind (fact + document) rzuca błąd (roadmap v1.3 "Dedup kind-aware", defense-in-depth — nieosiągalne dziś, bo ANN jest już kind-scoped, ale scalenie nigdy nie może po cichu wybrać jednego kind i zgubić semantyki pozostałych)', () => {
    expect(() =>
      pickCanonicalMerge([
        candidate({ id: 'mem_a', kind: 'fact', accessCount: 1 }),
        candidate({ id: 'mem_b', kind: 'document', accessCount: 0 }),
      ]),
    ).toThrow();
  });

  it('wszyscy członkowie tego samego kind (document) -> scalenie zwraca kind=document', () => {
    const payload = pickCanonicalMerge([
      candidate({ id: 'mem_a', kind: 'document', accessCount: 1 }),
      candidate({ id: 'mem_b', kind: 'document', accessCount: 0 }),
    ]);
    expect(payload.kind).toBe('document');
  });
});
