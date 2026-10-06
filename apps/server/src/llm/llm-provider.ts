import type { LlmChatMessage, LlmChatResult, LlmEndpoint } from './llm.types';

/**
 * Port providera LLM (roadmap v1.6) — wzorem `EmbeddingProvider`: interfejs + token DI, żeby testy mogły
 * podstawić deterministycznego fake'a bez HTTP. Różnica: endpoint (URL/model/klucz/timeout) NIE jest
 * stałą deploy-time, tylko konfiguracją z bazy czytaną per przebieg (G3) — więc provider jest bezstanowy
 * i dostaje `LlmEndpoint` przy każdym wywołaniu.
 */
export interface LlmProvider {
  /** `opts.json` → `response_format: {type: 'json_object'}` (G10). Rzuca `LlmHttpError`/`LlmTimeoutError`/
   * `LlmNetworkError`/`LlmResponseError`; komunikaty nigdy nie niosą klucza API ani ciała odpowiedzi. */
  chat(endpoint: LlmEndpoint, messages: LlmChatMessage[], opts: { json: boolean }): Promise<LlmChatResult>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** Odpowiedź HTTP spoza 2xx. Niesie tylko status i `Retry-After` — ciała odpowiedzi nigdy nie czytamy do komunikatu. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`LLM API http ${status}`);
    this.name = 'LlmHttpError';
  }
}

/** Brak odpowiedzi w limicie czasu (`AbortSignal.timeout`). */
export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

/** Błąd transportu (DNS, odmowa połączenia, TLS…). */
export class LlmNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmNetworkError';
  }
}

/** HTTP 2xx, ale ciało nie ma kształtu `choices[0].message.content` (np. zły adres, nie `/chat/completions`). */
export class LlmResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmResponseError';
  }
}
