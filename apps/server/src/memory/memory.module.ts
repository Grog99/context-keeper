import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { UsageModule } from '../usage/usage.module';
import { AutoModeUndoService } from './auto-mode-undo.service';
import { MemoryAdminService } from './memory-admin.service';
import { MemoryService } from './memory.service';

@Module({
  imports: [AuditModule, UsageModule, ProposalsModule],
  providers: [MemoryService, MemoryAdminService, AutoModeUndoService],
  exports: [MemoryService, MemoryAdminService, AutoModeUndoService],
})
export class MemoryModule {}
