import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PurgeService } from './purge.service';

/**
 * Rejestrowany WYŁĄCZNIE w `CliModule` (jak `NightlyModule`, FR-S3 "nie wystawiony przez MCP") —
 * hard-purge to uprzywilejowana operacja CLI-only, nigdy część `AppModule`/procesu HTTP/dashboardu
 * (przycisk w dashboardzie → v1.1 wg roadmapy). `DB`, `AppConfigService` przychodzą z globalnych
 * modułów — tylko `AuditModule` trzeba zaimportować jawnie.
 */
@Module({
  imports: [AuditModule],
  providers: [PurgeService],
  exports: [PurgeService],
})
export class PurgeModule {}
