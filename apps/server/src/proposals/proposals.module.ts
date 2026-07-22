import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ProposalsService } from './proposals.service';

/** DB, `EmbeddingService`, `AppConfigService` przychodzą z globalnych `DbModule`/`EmbeddingsModule`/
 * `ConfigModule` — tylko `AuditModule` trzeba zaimportować jawnie (tak samo jak `MemoryModule`). */
@Module({
  imports: [AuditModule],
  providers: [ProposalsService],
  exports: [ProposalsService],
})
export class ProposalsModule {}
