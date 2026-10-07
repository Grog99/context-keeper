import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/db.tokens';
import { findNearDuplicates, NearDuplicateDeadlineError } from '../src/memory/near-duplicates';

/** Baza, której dotknięcie wywala test — dowodzi, że ścieżka deadline nie sięga do Postgresa. */
const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error('db nie powinna być dotknięta po przekroczeniu deadline');
    },
  },
) as unknown as Database;

describe('findNearDuplicates — budżet czasu (unit)', () => {
  it('deadline już minięty → NearDuplicateDeadlineError, bez zapytania do bazy', async () => {
    await expect(
      findNearDuplicates({
        db: untouchableDb,
        queryVectors: [[0.1, 0.2]],
        embeddingModel: 'm',
        kind: 'fact',
        projectId: 'proj_x',
        maxDistance: 0.1,
        deadline: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(NearDuplicateDeadlineError);
  });

  it('brak wektorów → [] bez zapytania do bazy (nawet po deadline nic nie jest sprawdzane)', async () => {
    await expect(
      findNearDuplicates({
        db: untouchableDb,
        queryVectors: [],
        embeddingModel: 'm',
        kind: 'document',
        projectId: 'proj_x',
        maxDistance: 0.1,
        deadline: Date.now() - 1,
      }),
    ).resolves.toEqual([]);
  });
});
