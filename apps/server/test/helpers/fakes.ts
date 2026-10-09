import { EMBEDDING_DIM } from '../../src/db/schema';
import type { EmbeddingProvider } from '../../src/embeddings/embedding-provider';
import type { LlmProvider } from '../../src/llm/llm-provider';
import type { LlmChatMessage, LlmChatResult, LlmEndpoint } from '../../src/llm/llm.types';

/**
 * Wektor dla tekstu bez `register()`: stała tablica (każde wywołanie zwraca jej KOPIĘ) albo
 * `{ freshAxisFrom: n }` — każdy nowy tekst dostaje świeżą, parami ortogonalną oś jednostkową
 * (kolejno od osi `n`, zapamiętaną, więc ten sam tekst zawsze daje ten sam wektor).
 */
export type StubEmbeddingFallback = number[] | { freshAxisFrom: number };

/** Domyślny stały wektor stuba — do testów MECHANIKI (revisions, audit, scope), nie rankingu. */
export const UNIFORM_STUB_VECTOR: readonly number[] = new Array<number>(EMBEDDING_DIM).fill(0.01);

/**
 * Deterministyczny stub `EmbeddingProvider` — testcontainers nie odpala prawdziwego sidecara TEI, a port
 * istnieje właśnie po to, żeby podstawić fake bez HTTP. Używaj tego zamiast kopiować klasę do speca.
 *
 * - `register(text, vector)` mapuje DOKŁADNY tekst (np. treść query albo tekst chunku z `chunk()`) na wektor
 *   (zwracany przez referencję); nierejestrowany tekst dostaje `fallback`.
 * - `fallback` domyślnie to `UNIFORM_STUB_VECTOR` (jeden stały wektor dla wszystkiego — testy mechaniki).
 *   Gdy test sprawdza ranking / odległości, podaj wektor, który nigdy nie wygra z zarejestrowanymi; gdy
 *   kolejne zapisy o różnej treści nie mogą być względem siebie prawie-duplikatami, podaj
 *   `{ freshAxisFrom: n }` (osie `< n` zostają dla wektorów testu).
 * - `throwOnEmbed` — symulacja awarii providera (`embed()` rzuca, `health()` zwraca `false`).
 * - `delayMs` — opóźnienie `embed()` PRZED sprawdzeniem `throwOnEmbed` (testy budżetu czasu zapisu).
 */
export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dim = EMBEDDING_DIM;
  throwOnEmbed = false;
  delayMs = 0;
  private readonly known = new Map<string, number[]>();
  private nextAxis: number | undefined;

  constructor(
    public model: string,
    private readonly fallback: StubEmbeddingFallback = [...UNIFORM_STUB_VECTOR],
  ) {
    this.nextAxis = Array.isArray(fallback) ? undefined : fallback.freshAxisFrom;
  }

  register(text: string, vector: number[]): void {
    this.known.set(text, vector);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.throwOnEmbed) throw new Error('StubEmbeddingProvider: symulowana awaria providera');
    return texts.map((t) => this.known.get(t) ?? this.fallbackFor(t));
  }

  async health(): Promise<boolean> {
    return !this.throwOnEmbed;
  }

  private fallbackFor(text: string): number[] {
    if (Array.isArray(this.fallback)) return this.fallback.slice();
    const v = new Array<number>(EMBEDDING_DIM).fill(0);
    v[this.nextAxis!++] = 1;
    this.known.set(text, v);
    return v;
  }
}

/**
 * Stub `EmbeddingProvider` o małym wymiarze (`dim = 4`) do testów `health()` — kontrolowany wynik
 * (`healthResult`: `true` / `false` / `'throw'`) i opóźnienie (`healthDelayMs`), bez bazy. NIE nadaje się
 * do testów z bazą (wymiar ≠ `EMBEDDING_DIM`) — tam użyj `StubEmbeddingProvider`.
 */
export class HealthStubEmbeddingProvider implements EmbeddingProvider {
  readonly dim = 4;
  healthResult: boolean | 'throw' = true;
  healthDelayMs = 0;

  constructor(public model: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0, 0]);
  }

  async health(): Promise<boolean> {
    if (this.healthDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.healthDelayMs));
    }
    if (this.healthResult === 'throw') {
      throw new Error('StubProvider: symulowana awaria health-checku');
    }
    return this.healthResult;
  }
}

/** Odpowiedź fake'a LLM na wiadomość użytkownika: treść (JSON jako string) albo `Error` do rzucenia z `chat()`. */
export type FakeLlmResponder = (user: string) => string | Error;

/** Nagłówek wpisu (`header: …`) z wiadomości użytkownika promptu nocnego jobu. */
export const headerOf = (user: string): string => /^header: (.*)$/m.exec(user)?.[1] ?? '';

/**
 * Fake `LlmProvider` — bez HTTP; `respond` (WYMAGANY, każdy spec podaje własny) dostaje ostatnią wiadomość
 * użytkownika i zwraca treść odpowiedzi albo `Error` (wtedy `chat()` rzuca). Zapisuje wszystkie wiadomości
 * (`users`), a `onCall` pozwala wstrzymać/obserwować wywołanie (np. wyścig z budżetem czasu).
 * Licz wywołania pod warunek przez `callsWhere(predicate)`.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly users: string[] = [];
  onCall?: (user: string) => Promise<void>;

  constructor(public respond: FakeLlmResponder) {}

  get calls(): number {
    return this.users.length;
  }
  get headers(): string[] {
    return this.users.map(headerOf);
  }
  callsWhere(predicate: (user: string) => boolean): number {
    return this.users.filter(predicate).length;
  }

  async chat(_endpoint: LlmEndpoint, messages: LlmChatMessage[]): Promise<LlmChatResult> {
    const user = messages[messages.length - 1].content;
    this.users.push(user);
    if (this.onCall) await this.onCall(user);
    const out = this.respond(user);
    if (out instanceof Error) throw out;
    return { content: out, model: 'fake', latencyMs: 1 };
  }
}
