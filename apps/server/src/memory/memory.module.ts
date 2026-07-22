import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MemoryAdminService } from './memory-admin.service';
import { MemoryService } from './memory.service';

@Module({
  imports: [AuditModule],
  providers: [MemoryService, MemoryAdminService],
  exports: [MemoryService, MemoryAdminService],
})
export class MemoryModule {}
