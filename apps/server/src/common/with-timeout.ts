/**
 * Twardy budżet czasu na promise: `Promise.race` z timerem, który zawsze jest sprzątany. Odrzuca
 * `Error('timed out after Nms')`; opakowana operacja NIE jest przerywana (JS nie ma cancellation) —
 * wołający, który potrzebuje ograniczyć jej dalszą pracę, sprawdza sam deadline między krokami
 * (patrz `memory/near-duplicates.ts`). Współdzielone przez embedding (`EmbeddingService`) i detekcję
 * prawie-duplikatów przy zapisie (`MemoryService.save`).
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
