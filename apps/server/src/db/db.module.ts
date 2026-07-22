import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppConfigService } from '../config/config.service';
import { DB, PG_POOL } from './db.tokens';
import * as schema from './schema';

/**
 * Globalny moduł bazy. Jedna pula pg + jedna instancja Drizzle (z typowaną schemą) w DI.
 * Pula zamykana przy zamykaniu aplikacji (graceful shutdown).
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new Pool({ connectionString: config.get('DATABASE_URL') }),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
