import { Injectable } from '@nestjs/common';
import {
  LlmHttpError,
  LlmNetworkError,
  LlmResponseError,
  LlmTimeoutError,
  type LlmProvider,
} from './llm-provider';
import type { LlmChatMessage, LlmChatResult, LlmEndpoint } from './llm.types';

/** Zamienia wystąpienia klucza API w tekście na `***` — obrona w głębi (fetch nie wstrzykuje nagłówków do
 * komunikatu wyjątku, ale nie zakładamy tego na zawsze). Pusty/`null` klucz → tekst bez zmian. */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}

/** `Retry-After`: liczba sekund albo data HTTP → milisekundy; wszystko inne (brak, śmieci, ujemne) → `null`. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Krótki, bezpieczny opis błędu sieciowego: kod przyczyny (`ENOTFOUND`, `ECONNREFUSED`…) albo jej komunikat. */
function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const c = cause as { code?: unknown; message?: unknown };
    if (typeof c.code === 'string') return `${err.message} (${c.code})`;
    if (typeof c.message === 'string') return `${err.message} (${c.message})`;
  }
  return err.message;
}

interface ChatCompletionsBody {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * Implementacja OpenAI-kształtnego `POST …/chat/completions` (OpenAI, OpenRouter, Groq, Ollama, vLLM) —
 * wzorem `embeddings/api.provider.ts`, ale bez SDK i bez vendor locka (ust. 1). Żądanie MINIMALNE:
 * `{model, messages}` (+ `response_format: json_object` przy `json`), bez `max_tokens`/`temperature` —
 * te parametry są różnie wspierane przez poszczególne serwery.
 *
 * `Authorization: Bearer …` wtedy i tylko wtedy, gdy klucz jest ustawiony (ust. 5). Klucz NIGDY nie trafia
 * do komunikatu błędu: błędy HTTP niosą wyłącznie status (ciała odpowiedzi nie czytamy), błędy sieciowe
 * tylko opis przyczyny, a każdy komunikat dodatkowo przechodzi przez `redactSecret`.
 */
@Injectable()
export class OpenAiChatProvider implements LlmProvider {
  async chat(
    endpoint: LlmEndpoint,
    messages: LlmChatMessage[],
    opts: { json: boolean },
  ): Promise<LlmChatResult> {
    const started = performance.now();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
    const body: Record<string, unknown> = { model: endpoint.model, messages };
    if (opts.json) body.response_format = { type: 'json_object' };

    let res: Response;
    let json: ChatCompletionsBody;
    try {
      res = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      });
      if (!res.ok) {
        // Ciała nie czytamy — status wystarcza, a ciało błędu bywa echem żądania.
        throw new LlmHttpError(res.status, parseRetryAfter(res.headers.get('retry-after')));
      }
      json = (await res.json()) as ChatCompletionsBody;
    } catch (err) {
      if (err instanceof LlmHttpError) throw err;
      if (isAbortLike(err)) {
        throw new LlmTimeoutError(
          redactSecret(`LLM API timeout po ${endpoint.timeoutMs} ms`, endpoint.apiKey),
        );
      }
      if (err instanceof SyntaxError) {
        throw new LlmResponseError('LLM API: odpowiedź nie jest poprawnym JSON-em');
      }
      throw new LlmNetworkError(redactSecret(`LLM API: ${describeNetworkError(err)}`, endpoint.apiKey));
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new LlmResponseError('LLM API: brak choices[0].message.content w odpowiedzi');
    }
    return {
      content,
      model: typeof json.model === 'string' ? json.model : null,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
