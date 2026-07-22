import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfigService);

  // Tryb B (bring-your-own-proxy): honoruj X-Forwarded-* (Secure cookie, realny IP, scheme) — §9.
  if (config.get('TRUST_PROXY')) {
    app.set('trust proxy', true);
  }

  // Zamknięcie puli pg (DbModule.onModuleDestroy) przy SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // v1: jeden proces, jeden port (PORT_MCP). Rozdział /mcp vs dashboard po porcie — Faza 5.
  const port = config.get('PORT_MCP');
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log(`Context Keeper listening on :${port}`, 'Bootstrap');
}

void bootstrap();
