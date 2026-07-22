import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { ProjectsModule } from './projects/projects.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        autoLogging: true,
        // Nigdy nie loguj bearer tokena.
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    DbModule,
    ProjectsModule,
    HealthModule,
  ],
})
export class AppModule {}
