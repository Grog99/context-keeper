import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import type { AppModule as AppModuleType } from '../../src/app.module';
import * as schema from '../../src/db/schema';

export interface McpE2eApp {
  app: NestExpressApplication;
  /** `http://127.0.0.1:<port>/mcp` */
  baseUrl: string;
  /** Zamyka aplikację i zatrzymuje kontener (bezpieczne przy częściowo wystartowanym środowisku). */
  stop(): Promise<void>;
}

/**
 * Serwer Nest in-process (port efemeryczny) na świeżym kontenerze pgvector — wspólny start dla
 * specyfikacji MCP e2e. `envOverrides` trafia do `process.env` razem z `DATABASE_URL`.
 */
export async function startMcpE2eApp(envOverrides: Record<string, string> = {}): Promise<McpE2eApp> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
  let app: NestExpressApplication | undefined;
  try {
    // KRYTYCZNE: DATABASE_URL musi trafić do process.env PRZED zaimportowaniem app.module.ts —
    // `@Module({ imports: [ConfigModule.forRoot(), ...] })` woła `loadEnv()` w momencie EWALUACJI
    // dekoratora (czyli przy imporcie modułu), nie przy instancjonowaniu. Import na górze pliku
    // byłby zbyt wczesny (przed startem kontenera) — stąd dynamic import dopiero tutaj.
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
    Object.assign(process.env, envOverrides);

    const migPool = new Pool({ connectionString: container.getConnectionUri() });
    const migDb = drizzle(migPool, { schema });
    await migrate(migDb, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    await migPool.end();

    const { AppModule }: { AppModule: typeof AppModuleType } = await import('../../src/app.module');
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const started = app;
    return {
      app: started,
      baseUrl: `http://127.0.0.1:${port}/mcp`,
      stop: async () => {
        await started.close();
        await container.stop();
      },
    };
  } catch (err) {
    await app?.close().catch(() => {});
    await container.stop().catch(() => {});
    throw err;
  }
}
