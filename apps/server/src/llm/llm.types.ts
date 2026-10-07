import type { SecretKind } from '../common/secret-scanner';

/** Konfiguracja jednego endpointu — przekazywana do providera przy KAŻDYM wywołaniu (provider jest
 * bezstanowy, a konfiguracja żyje w bazie i jest czytana per przebieg, G3). `apiKey = null` → brak
 * nagłówka `Authorization` (lokalne Ollama/vLLM, ust. 5). */
export interface LlmEndpoint {
  /** Pełny URL `…/chat/completions` (ta sama konwencja co `EMBEDDING_API_URL`). */
  url: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
}

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatResult {
  /** `choices[0].message.content`. */
  content: string;
  /** Model zwrócony przez provider (`model` w odpowiedzi) — `null`, gdy go nie podał. */
  model: string | null;
  latencyMs: number;
}

/** Liczniki kroku LLM jednego przebiegu — płaskie pola `NightlyCounters` (ust. 9), więc trafiają do
 * `nightly_run.metadata`, podsumowania CLI i lustra typów dashboardu. */
export interface LlmCounters {
  /** Żądania HTTP faktycznie wysłane do providera (retry wlicza się, G9). */
  llmCalls: number;
  /** Wywołania logiczne zakończone błędem po ewentualnym retry (HTTP, timeout, sieć, niezgodność ze schematem). */
  llmErrors: number;
  /** Pominięte, bo cap żądań na przebieg był wyczerpany. */
  llmSkippedCap: number;
  /** Pominięte przez bezpiecznik po `K` kolejnych błędach (G8). */
  llmSkippedBreaker: number;
  /** Pominięte, bo treść trafiła w skaner sekretów (G13). */
  llmSkippedSecret: number;
  /** Pominięte, bo zapisanego klucza API nie da się odszyfrować (G7). */
  llmSkippedKeyUnreadable: number;
}

export const EMPTY_LLM_COUNTERS: LlmCounters = {
  llmCalls: 0,
  llmErrors: 0,
  llmSkippedCap: 0,
  llmSkippedBreaker: 0,
  llmSkippedSecret: 0,
  llmSkippedKeyUnreadable: 0,
};

/** Stan kroku LLM w przebiegu: `disabled` (opt-in niewłączony), `ready`, `key_unreadable` (G7),
 * `unavailable` (odczyt ustawień z bazy zawiódł — fail-open, przebieg i tak się kończy `success`). */
export type LlmRunState = 'disabled' | 'ready' | 'key_unreadable' | 'unavailable';

export interface SkippedSecretEntry {
  memoryId: string;
  secretType: SecretKind;
}

/** Blok `llm` w wyniku przebiegu i w `nightly_run.metadata` (null przy `skipped-locked` na poziomie wyniku). */
export interface NightlyLlmReport {
  state: LlmRunState;
  /** Wpisy pominięte przez skaner sekretów w tym przebiegu (id pamięci + typ, BEZ materiału), do `LLM_SKIPPED_SECRET_LIST_MAX`. */
  skippedSecret: SkippedSecretEntry[];
}

// ---- ustawienia (REST / serwis) ------------------------------------------

/** Stan klucza API widoczny dla SPA — nigdy sam klucz ani jego fragment (G6). */
export type LlmApiKeyState = 'none' | 'set' | 'unreadable';

export interface LlmSettingsDto {
  enabled: boolean;
  endpoint: string | null;
  model: string | null;
  callCap: number;
  timeoutMs: number;
  apiKey: LlmApiKeyState;
  /** `false` → serwer nie ma `SECRETS_ENCRYPTION_KEY`: zapis klucza API jest odrzucany (G5). */
  encryptionKeyConfigured: boolean;
  /** `null`, gdy wiersz instancji nie istnieje (zwracane są wartości domyślne). */
  updatedAt: string | null;
}

export type LlmApiKeyAction =
  | { action: 'keep' }
  | { action: 'set'; value: string }
  | { action: 'clear' };

export interface LlmSettingsUpdate {
  enabled: boolean;
  endpoint: string | null;
  model: string | null;
  callCap: number;
  timeoutMs: number;
  apiKey: LlmApiKeyAction;
}

/** Wynik „Sprawdź połączenie" / `check-llm` — zawsze dane, nigdy wyjątek. `error` jest czytelny po polsku i nigdy nie niesie klucza. */
export type LlmCheckResult =
  | { ok: true; model: string; latencyMs: number; endpoint: string; enabled: boolean }
  | { ok: false; error: string };
