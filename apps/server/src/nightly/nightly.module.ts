import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { UsageModule } from '../usage/usage.module';
import { NightlyService } from './nightly.service';
import { PRUNE_SCORER } from './nightly.types';
import { RecencyPruneScorer } from './prune-scorer';

/**
 * Rejestrowany w `CliModule` (plan Fazy 6 §1 "Overall shape", standalone `nest-commander` context)
 * ORAZ od roadmap v1.1 w `DashboardModule` (ręczny trigger z ekranu "Operacje", `NightlyController`,
 * `POST /api/nightly/run`). Import modułu tylko rejestruje providery — `NightlyService.run()`
 * startuje wyłącznie na explicit wywołanie (CLI `run-nightly` albo ten endpoint), nigdy sam z siebie
 * przy starcie procesu HTTP. `DB`, `PG_POOL`, `EmbeddingService`, `AppConfigService` przychodzą z
 * globalnych modułów — tylko `AuditModule` trzeba zaimportować jawnie (tak samo jak w
 * `MemoryModule`/`ProposalsModule`).
 */
@Module({
  imports: [AuditModule, UsageModule],
  providers: [NightlyService, { provide: PRUNE_SCORER, useClass: RecencyPruneScorer }],
  exports: [NightlyService],
})
export class NightlyModule {}
