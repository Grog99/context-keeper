import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { McpIpThrottleGuard } from './mcp-ip-throttle.guard';
import { McpRateLimitGuard } from './mcp-rate-limit.guard';
import { McpController } from './mcp.controller';

@Module({
  imports: [ProjectsModule, MemoryModule, RateLimitModule],
  controllers: [McpController],
  providers: [McpIpThrottleGuard, McpRateLimitGuard],
})
export class McpModule {}
