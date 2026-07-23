import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PurgeService } from './purge.service';

/**
 * Rejestrowany w `CliModule` (jak `NightlyModule`, FR-S3 "nie wystawiony przez MCP") ORAZ od
 * roadmap v1.1 w `DashboardModule` (przycisk "Hard-purge" w `MemoryBrowserScreen`, przez
 * `MemoriesController.purge`/`purgePreview`). Hard-purge zostaje uprzywilejowaną, rzadką operacją —
 * dostęp idzie wyłącznie przez `SessionGuard`/`CsrfGuard` kontroler-scoped na powierzchni
 * dashboardu, NIGDY przez publiczny `/mcp`. `DB`, `AppConfigService` przychodzą z globalnych
 * modułów — tylko `AuditModule` trzeba zaimportować jawnie.
 */
@Module({
  imports: [AuditModule],
  providers: [PurgeService],
  exports: [PurgeService],
})
export class PurgeModule {}
