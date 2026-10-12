import type { Pool } from 'pg';

/**
 * Obietnica rozwiązywana, gdy KAŻDY klient obecny teraz w puli faktycznie zamknie socket — pg-pool
 * emituje `remove` dopiero po `close` strumienia. Rejestruj PRZED `pool.end()` (albo przed
 * `app.close()`, gdy pulę zamyka `DbModule.onModuleDestroy`).
 */
export function poolDrained(pool: Pool): Promise<void> {
  let pending = pool.totalCount;
  if (pending === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const onRemove = (): void => {
      pending -= 1;
      if (pending === 0) {
        pool.off('remove', onRemove);
        resolve();
      }
    };
    pool.on('remove', onRemove);
  });
}

/**
 * `pool.end()` i czekanie na zamknięcie socketów — wołaj PRZED `container.stop()`.
 *
 * Samo `await pool.end()` nie wystarcza: pg-pool rozwiązuje je, gdy tylko wyczyści listę klientów,
 * zanim ich sockety się zamkną. `container.stop()` (STOPSIGNAL SIGINT → fast shutdown Postgresa)
 * trafia wtedy w backendy jeszcze podłączone i wysyła im FATAL 57P01 „terminating connection due to
 * administrator command" — błąd ląduje na `idleListener` klienta, pula emituje `error` bez
 * listenera i Vitest raportuje „Unhandled Error", choć wszystkie testy przeszły.
 */
export async function endPool(pool: Pool | undefined): Promise<void> {
  if (!pool) return;
  const drained = poolDrained(pool);
  await pool.end();
  await drained;
}
