import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfigService, ENV } from './config.service';
import { loadEnv } from './env';

/**
 * Globalny moduł konfiguracji. Parsuje i waliduje env raz przy starcie (twardy fail),
 * następnie udostępnia zamrożony obiekt przez DI (token ENV + AppConfigService).
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(): DynamicModule {
    const env = Object.freeze(loadEnv());
    return {
      module: ConfigModule,
      providers: [
        { provide: ENV, useValue: env },
        AppConfigService,
      ],
      exports: [ENV, AppConfigService],
    };
  }
}
