import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { createSurfaceMiddleware } from '../src/dashboard/surface.middleware';

const PORT_MCP = 3000;
const PORT_DASHBOARD = 3001;

/** Przepuszcza żądanie przez middleware; zwraca `'next'` albo kod odpowiedzi — nigdy oba naraz. */
function run(localPort: number, path: string): 'next' | number {
  const middleware = createSurfaceMiddleware(PORT_MCP, PORT_DASHBOARD);
  const req = { socket: { localPort }, path } as unknown as Request;
  const state = { status: undefined as number | undefined, ended: false };
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    end() {
      state.ended = true;
      return this;
    },
  } as unknown as Response;
  let nextCalls = 0;
  const next: NextFunction = () => {
    nextCalls++;
  };

  middleware(req, res, next);

  if (nextCalls > 0) {
    expect(nextCalls).toBe(1);
    expect(state.status).toBeUndefined();
    expect(state.ended).toBe(false);
    return 'next';
  }
  expect(state.ended).toBe(true);
  expect(state.status).toBeDefined();
  return state.status as number;
}

describe('createSurfaceMiddleware — rozdział powierzchni po porcie (tech-review #13, §9 tech-stack)', () => {
  describe('PORT_MCP — allowlista: tylko /mcp* i /health', () => {
    it.each(['/mcp', '/mcp/sse', '/health'])('%s → przepuszcza', (path) => {
      expect(run(PORT_MCP, path)).toBe('next');
    });

    it.each(['/api/proposals', '/', '/assets/index-abc123.js', '/mcpx'])('%s → 404', (path) => {
      expect(run(PORT_MCP, path)).toBe(404);
    });
  });

  describe('PORT_DASHBOARD — blocklista: tylko /mcp* odrzucone', () => {
    it.each(['/mcp', '/mcp/sse'])('%s → 404', (path) => {
      expect(run(PORT_DASHBOARD, path)).toBe(404);
    });

    it.each(['/api/proposals', '/', '/health', '/mcpx'])('%s → przepuszcza', (path) => {
      expect(run(PORT_DASHBOARD, path)).toBe('next');
    });
  });
});
