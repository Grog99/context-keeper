import { createServer, type RequestListener, type Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';
import { createSurfaceMiddleware } from './dashboard/surface.middleware';

// Body dashboardu (dokumenty do ~256 KB) potrzebuje wyższego limitu niż domyślny express.json();
// skopowany tylko do /api, żeby nie poluzować limitu na /mcp.
const DASHBOARD_JSON_LIMIT = '512kb';

function listen(handler: RequestListener, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Domyślny body-parser wyłączony — montujemy go ręcznie poniżej, żeby zeskopować
    // podniesiony limit dashboardu wyłącznie do /api (patrz DASHBOARD_JSON_LIMIT).
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfigService);

  // Tryb B (bring-your-own-proxy): honoruj X-Forwarded-* (Secure cookie, realny IP, scheme) — §9.
  if (config.get('TRUST_PROXY')) {
    app.set('trust proxy', true);
  }

  app.use('/api', json({ limit: DASHBOARD_JSON_LIMIT }));
  app.use('/api', urlencoded({ extended: true, limit: DASHBOARD_JSON_LIMIT }));
  app.use(json());
  app.use(urlencoded({ extended: true }));
  // Podpisany cookie sesji dashboardu (Faza 5) — sekret współdzielony z SessionGuard.
  app.use(cookieParser(config.get('SESSION_SECRET')));

  const portMcp = config.get('PORT_MCP');
  const portDashboard = config.get('PORT_DASHBOARD');
  app.use(createSurfaceMiddleware(portMcp, portDashboard));

  // Zamknięcie puli pg (DbModule.onModuleDestroy) przy SIGTERM/SIGINT.
  app.enableShutdownHooks();

  await app.init();

  // Dwa porty, jeden Express instance (Faza 5 — §9 tech-stack): pozwala proxy publicznie
  // wystawić tylko /mcp, trzymając dashboard za VPN/CF Access.
  const expressInstance = app.getHttpAdapter().getInstance() as RequestListener;
  const servers = await Promise.all([listen(expressInstance, portMcp), listen(expressInstance, portDashboard)]);

  const closeAll = (): void => {
    for (const server of servers) server.close();
  };
  process.on('SIGTERM', closeAll);
  process.on('SIGINT', closeAll);

  app.get(Logger).log(`Context Keeper listening on :${portMcp} (mcp) i :${portDashboard} (dashboard)`, 'Bootstrap');
}

void bootstrap();
