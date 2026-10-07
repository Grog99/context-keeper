import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LlmHttpError,
  LlmNetworkError,
  LlmResponseError,
  LlmTimeoutError,
} from '../src/llm/llm-provider';
import type { LlmEndpoint } from '../src/llm/llm.types';
import { OpenAiChatProvider, parseRetryAfter, redactSecret } from '../src/llm/openai-chat.provider';

const SENTINEL = 'sk-sentinel-DO-NOT-LEAK-98765';
const MESSAGES = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'usr' },
];

function endpoint(overrides: Partial<LlmEndpoint> = {}): LlmEndpoint {
  return {
    url: 'https://llm.example.com/v1/chat/completions',
    model: 'gpt-test',
    apiKey: SENTINEL,
    timeoutMs: 5000,
    ...overrides,
  };
}

function okResponse(content = '{"ok":true}', model: string | null = 'gpt-test-2026'): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ model, choices: [{ message: { content } }] }),
  }));
}

/** Odpowiedź błędu, której ciało echo-uje klucz (jak niektóre serwery) — provider nie może go przepuścić. */
function errorResponse(status: number, headers: Record<string, string> = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => ({ error: { message: `bad key ${SENTINEL}` } }),
    text: async () => `bad key ${SENTINEL}`,
  }));
}

describe('OpenAiChatProvider (OpenAI-kształtny /chat/completions)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST pod podany URL z minimalnym body {model, messages, response_format} i parsuje odpowiedź', async () => {
    const fetchMock = okResponse('{"ok":true}', 'gpt-test-2026');
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OpenAiChatProvider().chat(endpoint(), MESSAGES, { json: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-test',
      messages: MESSAGES,
      response_format: { type: 'json_object' },
    });
    expect(result.content).toBe('{"ok":true}');
    expect(result.model).toBe('gpt-test-2026');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('json=false: bez response_format; żadnych max_tokens/temperature', async () => {
    const fetchMock = okResponse();
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAiChatProvider().chat(endpoint(), MESSAGES, { json: false });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(['messages', 'model']);
  });

  it('Authorization: Bearer <klucz> gdy klucz ustawiony', async () => {
    const fetchMock = okResponse();
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAiChatProvider().chat(endpoint(), MESSAGES, { json: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SENTINEL}`);
  });

  it.each([null, ''])('brak nagłówka Authorization gdy apiKey=%j (lokalne Ollama/vLLM)', async (apiKey) => {
    const fetchMock = okResponse();
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAiChatProvider().chat(endpoint({ apiKey }), MESSAGES, { json: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('model w odpowiedzi opcjonalny -> model:null', async () => {
    vi.stubGlobal('fetch', okResponse('{}', null));
    const result = await new OpenAiChatProvider().chat(endpoint(), MESSAGES, { json: true });
    expect(result.model).toBeNull();
  });

  it.each([401, 403, 404, 500])('HTTP %i -> LlmHttpError ze statusem; komunikat BEZ klucza i BEZ ciała odpowiedzi', async (status) => {
    vi.stubGlobal('fetch', errorResponse(status));

    const err = await new OpenAiChatProvider()
      .chat(endpoint(), MESSAGES, { json: true })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).status).toBe(status);
    expect((err as LlmHttpError).message).toContain(String(status));
    expect(String(err)).not.toContain(SENTINEL);
    expect((err as LlmHttpError).message).not.toContain('bad key');
  });

  it('Retry-After: 2 -> retryAfterMs=2000; brak/śmieci -> null', async () => {
    vi.stubGlobal('fetch', errorResponse(429, { 'retry-after': '2' }));
    const err = (await new OpenAiChatProvider()
      .chat(endpoint(), MESSAGES, { json: true })
      .catch((e: unknown) => e)) as LlmHttpError;
    expect(err.retryAfterMs).toBe(2000);

    vi.stubGlobal('fetch', errorResponse(503));
    const err2 = (await new OpenAiChatProvider()
      .chat(endpoint(), MESSAGES, { json: true })
      .catch((e: unknown) => e)) as LlmHttpError;
    expect(err2.retryAfterMs).toBeNull();
  });

  it('parseRetryAfter: sekundy, data HTTP, śmieci', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('abc', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('timeout: fetch honorujący signal, który nigdy nie odpowiada -> LlmTimeoutError (nie surowy AbortError)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );

    const err = await new OpenAiChatProvider()
      .chat(endpoint({ timeoutMs: 50 }), MESSAGES, { json: true })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(String(err)).toContain('50 ms');
    expect(String(err)).not.toContain(SENTINEL);
  });

  it('błąd sieciowy: komunikat z opisem przyczyny; klucz w komunikacie zostaje zredagowany', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(`fetch failed for key ${SENTINEL}`, { cause: { code: 'ENOTFOUND' } });
      }),
    );

    const err = await new OpenAiChatProvider()
      .chat(endpoint(), MESSAGES, { json: true })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(LlmNetworkError);
    expect((err as Error).message).toContain('ENOTFOUND');
    expect((err as Error).message).toContain('***');
    expect(String(err)).not.toContain(SENTINEL);
  });

  it('2xx bez choices[0].message.content -> LlmResponseError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ hello: 'world' }) })),
    );
    await expect(new OpenAiChatProvider().chat(endpoint(), MESSAGES, { json: true })).rejects.toBeInstanceOf(
      LlmResponseError,
    );
  });

  it('2xx z ciałem niebędącym JSON-em -> LlmResponseError (bez cytowania ciała)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => JSON.parse('<html>proxy error</html>'),
      })),
    );
    const err = await new OpenAiChatProvider()
      .chat(endpoint(), MESSAGES, { json: true })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(LlmResponseError);
    expect(String(err)).not.toContain('proxy error');
  });

  it('redactSecret: zamienia wszystkie wystąpienia, pusty klucz nie zmienia tekstu', () => {
    expect(redactSecret(`a ${SENTINEL} b ${SENTINEL}`, SENTINEL)).toBe('a *** b ***');
    expect(redactSecret('tekst', null)).toBe('tekst');
    expect(redactSecret('tekst', '')).toBe('tekst');
  });
});
