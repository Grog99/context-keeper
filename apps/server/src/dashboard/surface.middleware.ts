import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Rozdział powierzchni po porcie (§9 tech-stack — "Faza 5"), defense-in-depth POZA proxy: nawet
 * trafiając bezpośrednio na `PORT_MCP`, powierzchnia dashboardu (`/api*`, SPA) tam nie odpowiada;
 * odwrotnie, `/mcp*` nie odpowiada na `PORT_DASHBOARD`. `PORT_MCP` jest **allowlistą** (tylko `/mcp`
 * + `/health`) — bezpieczniejsze niż próba wyliczenia „co jest zasobem SPA" na blokliście.
 * `PORT_DASHBOARD` jest blokistą (tylko `/mcp` odrzucone) — wszystko inne (API, statyki, `/health`)
 * przechodzi.
 */
export function createSurfaceMiddleware(portMcp: number, portDashboard: number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const localPort = req.socket.localPort;
    const path = req.path;
    const isHealth = path === '/health';
    const isMcp = path === '/mcp' || path.startsWith('/mcp/');

    if (localPort === portMcp) {
      if (isHealth || isMcp) {
        next();
        return;
      }
      res.status(404).end();
      return;
    }

    if (localPort === portDashboard && isMcp) {
      res.status(404).end();
      return;
    }

    next();
  };
}
