import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { UsageModule } from '../usage/usage.module';
import { NightlyService } from './nightly.service';
import { PRUNE_SCORER } from './nightly.types';
import { RecencyPruneScorer } from './prune-scorer';

/**
 * Rejestrowany WYŁĄCZNIE w `CliModule` (plan Fazy 6 §1 "Overall shape") — nocny job to standalone
 * `nest-commander` context, nigdy część `AppModule`/procesu HTTP. `DB`, `PG_POOL`, `EmbeddingService`,
 * `AppConfigService` przychodzą z globalnych modułów — tylko `AuditModule` trzeba zaimportować
 * jawnie (tak samo jak w `MemoryModule`/`ProposalsModule`).
 */
@Module({
  imports: [AuditModule, UsageModule],
  providers: [NightlyService, { provide: PRUNE_SCORER, useClass: RecencyPruneScorer }],
  exports: [NightlyService],
})
export class NightlyModule {}
