import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MemoryService } from './memory.service';

@Module({
  imports: [AuditModule],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
