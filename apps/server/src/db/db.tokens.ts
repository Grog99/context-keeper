import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type * as schema from './schema';

/** Token DI dla instancji Drizzle (z typowaną schemą). */
export const DB = Symbol('DB');
/** Token DI dla surowej puli pg (rzadkie potrzeby: advisory locks, raw SQL spoza Drizzle). */
export const PG_POOL = Symbol('PG_POOL');

export type Database = NodePgDatabase<typeof schema>;
export type PgPool = Pool;
/** Handle przekazywany do callbacku `db.transaction(async (tx) => …)` — wyprowadzony wprost z typu
 * `Database`, żeby serwisy mogły przyjmować `Database | Tx` (np. `AuditService.log`, wołany zarówno
 * poza transakcją, jak i wewnątrz transakcyjnego rdzenia `ProposalsService.approve`). */
export type Tx = Parameters<Database['transaction']>[0] extends (tx: infer T) => unknown ? T : never;
