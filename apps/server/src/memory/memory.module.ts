import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { UsageModule } from '../usage/usage.module';
import { MemoryAdminService } from './memory-admin.service';
import { MemoryService } from './memory.service';

@Module({
  imports: [AuditModule, UsageModule, ProposalsModule],
  providers: [MemoryService, MemoryAdminService],
  exports: [MemoryService, MemoryAdminService],
})
export class MemoryModule {}
