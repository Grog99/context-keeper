import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AuditModule } from '../audit/audit.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { AuditController } from './audit.controller';
import { AuthController } from './auth/auth.controller';
import { CsrfGuard } from './auth/csrf.guard';
import { LoginThrottleService } from './auth/login-throttle.service';
import { SessionGuard } from './auth/session.guard';
import { ConfigController } from './config.controller';
import { MemoriesController } from './memories.controller';
import { MetricsController } from './metrics.controller';
import { ProjectsController } from './projects.controller';
import { ProposalsController } from './proposals.controller';

/**
 * Powierzchnia dashboardu (Faza 5, M0/M1 planu) — auth/sesja + REST API per ekran, spięte na
 * ISTNIEJĄCYCH serwisach Faz 1-4 (`ProposalsService`/`MemoryAdminService`/`ProjectsService`/
 * `AuditService`). `SessionGuard`/`CsrfGuard` są kontroler-scoped (dekorowane per-controller
 * poniżej), NIGDY globalne — `/mcp` nie może dostać żadnego nowego globalnego guarda (§Ryzyka planu).
 *
 * `ServeStaticModule` serwuje SPA (`dist/public`, budowane w M5) — osiągalne wyłącznie na
 * `PORT_DASHBOARD` dzięki `surface.middleware.ts` w `main.ts` (nie tutaj — middleware portowe jest
 * globalne z definicji Express, więc żyje na poziomie bootstrapu, nie modułu).
 */
@Module({
  imports: [
    ProposalsModule,
    MemoryModule,
    ProjectsModule,
    AuditModule,
    ServeStaticModule.forRoot({
      // `__dirname` w skompilowanym dist to `dist/dashboard/` (mirror src/dashboard/) — `dist/public`
      // wymaga wyjścia jeden poziom wyżej, NIE `join(__dirname, 'public')` (patrz M5: kopiowany tam
      // build `apps/dashboard`).
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/mcp{*splat}', '/health{*splat}', '/api{*splat}'],
      serveStaticOptions: { fallthrough: true },
    }),
  ],
  controllers: [
    AuthController,
    ProposalsController,
    MemoriesController,
    ProjectsController,
    AuditController,
    MetricsController,
    ConfigController,
  ],
  providers: [SessionGuard, CsrfGuard, LoginThrottleService],
})
export class DashboardModule {}
