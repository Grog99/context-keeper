import type { Options } from 'pino-http';

export const pinoHttpOptions: Options = {
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  autoLogging: true,
  // Nigdy nie loguj bearer tokena ani sesji dashboardu — ani w żądaniu (`Cookie`), ani w odpowiedzi
  // (`Set-Cookie` z loginu niesie `ck_session` + `ck_csrf`) (§10 tech-stack).
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
};
