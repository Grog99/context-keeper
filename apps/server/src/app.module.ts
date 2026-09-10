import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { pinoHttpOptions } from './common/logger-options';
import { ConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DbModule } from './db/db.module';
import { EmbeddingsModule } from './embeddings/embeddings.module';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';
import { ProjectsModule } from './projects/projects.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    LoggerModule.forRoot({ pinoHttp: pinoHttpOptions }),
    DbModule,
    EmbeddingsModule,
    ProjectsModule,
    HealthModule,
    McpModule,
    DashboardModule,
  ],
})
export class AppModule {}
