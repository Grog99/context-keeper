import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { ProjectsModule } from '../projects/projects.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { McpIpThrottleGuard } from './mcp-ip-throttle.guard';
import { McpRateLimitGuard } from './mcp-rate-limit.guard';
import { McpController } from './mcp.controller';

@Module({
  imports: [ProjectsModule, MemoryModule, RateLimitModule, OnboardingModule],
  controllers: [McpController],
  providers: [McpIpThrottleGuard, McpRateLimitGuard],
})
export class McpModule {}
