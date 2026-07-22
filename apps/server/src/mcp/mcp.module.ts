import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { McpRateLimitGuard } from './mcp-rate-limit.guard';
import { McpController } from './mcp.controller';

@Module({
  imports: [ProjectsModule, MemoryModule, RateLimitModule],
  controllers: [McpController],
  providers: [McpRateLimitGuard],
})
export class McpModule {}
