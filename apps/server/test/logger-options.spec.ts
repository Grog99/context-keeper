import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { pinoHttp } from 'pino-http';
import { describe, expect, it } from 'vitest';
import { pinoHttpOptions } from '../src/common/logger-options';

async function logOneRequest(): Promise<string> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pinoHttp({ ...pinoHttpOptions, level: 'info' }, sink);
  const server = createServer((req, res) => {
    logger(req, res);
    res.setHeader('Set-Cookie', ['ck_session=SESSION-SECRET; HttpOnly', 'ck_csrf=CSRF-SECRET']);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      headers: { authorization: 'Bearer ck_BEARER-SECRET', cookie: 'ck_session=REQ-SECRET' },
    });
    // pino-http loguje na `finish` odpowiedzi — daj pętli zdarzeń domknąć zapis.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return lines.join('');
}

describe('pinoHttpOptions — redact', () => {
  it('nie wypuszcza do logu ani nagłówków auth żądania, ani Set-Cookie odpowiedzi', async () => {
    const out = await logOneRequest();

    expect(out).toContain('request completed');
    expect(out).not.toContain('SESSION-SECRET');
    expect(out).not.toContain('CSRF-SECRET');
    expect(out).not.toContain('BEARER-SECRET');
    expect(out).not.toContain('REQ-SECRET');
    expect(out).toContain('[Redacted]');
  });
});
