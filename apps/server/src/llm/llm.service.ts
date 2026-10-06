import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { LlmRunBudget, parseLlmJson } from './llm-budget';
import {
  LLM_PROVIDER,
  LlmHttpError,
  LlmNetworkError,
  LlmResponseError,
  LlmTimeoutError,
  type LlmProvider,
} from './llm-provider';
import { LlmSettingsService } from './llm-settings.service';
import type { LlmCheckResult } from './llm.types';
import { redactSecret } from './openai-chat.provider';

const CHECK_SCHEMA = z.record(z.string(), z.unknown());

/**
 * Polski, czytelny opis błędu providera dla „Sprawdź połączenie" i `check-llm` (G2/G12). Zawsze składany ze
 * STAŁYCH fragmentów + statusu / opisu przyczyny z providera (już zredagowanego z klucza) — bez ciała odpowiedzi.
 */
function describeCheckError(err: unknown, timeoutMs: number): string {
  if (err instanceof LlmHttpError) {
    if (err.status === 401 || err.status === 403) return `HTTP ${err.status} — sprawdź klucz API.`;
    if (err.status === 404) {
      return 'HTTP 404 — sprawdź pełny adres endpointu (…/chat/completions) i nazwę modelu.';
    }
    if (err.status === 400) {
      return 'HTTP 400 — endpoint odrzucił żądanie; sprawdź nazwę modelu (część serwerów nie obsługuje response_format json_object).';
    }
    if (err.status === 429) return 'HTTP 429 — provider ogranicza liczbę żądań; spróbuj ponownie za chwilę.';
    return `HTTP ${err.status} — endpoint zwrócił błąd.`;
  }
  if (err instanceof LlmTimeoutError) {
    return `Brak odpowiedzi w ciągu ${Math.round(timeoutMs / 1000)} s — endpoint nie odpowiada albo model jest zbyt wolny.`;
  }
  if (err instanceof LlmNetworkError) return `Nie można połączyć się z endpointem — ${err.message}`;
  if (err instanceof LlmResponseError) {
    return 'Endpoint zwrócił odpowiedź w nieoczekiwanym kształcie — czy to na pewno adres …/chat/completions?';
  }
  return 'Nieoczekiwany błąd podczas wywołania modelu.';
}

/**
 * Fasada kroku LLM dla reszty aplikacji (roadmap v1.6): otwiera budżet przebiegu dla nocnego joba
 * (`openRunBudget`) i robi jedno testowe wywołanie (`checkConnection`, wspólne dla CLI `check-llm` i
 * przycisku „Sprawdź połączenie"). Konfiguracja jest czytana świeżo przy każdym wywołaniu (G3).
 */
@Injectable()
export class LlmService {
  constructor(
    private readonly settings: LlmSettingsService,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly audit: AuditService,
  ) {}

  /** Jeden SELECT na przebieg. Może rzucić przy awarii bazy — `NightlyService` łapie i używa `LlmRunBudget.unavailable()`. */
  async openRunBudget(actor: string): Promise<LlmRunBudget> {
    const cfg = await this.settings.loadRunConfig();
    switch (cfg.state) {
      case 'disabled':
        return LlmRunBudget.disabled();
      case 'key_unreadable':
        return LlmRunBudget.keyUnreadable();
      case 'ready':
        return LlmRunBudget.ready({
          provider: this.provider,
          endpoint: cfg.endpoint,
          callCap: cfg.callCap,
          audit: this.audit,
          actor,
        });
    }
  }

  /**
   * Jedno testowe wywołanie ZAPISANEJ konfiguracji (także gdy krok jest wyłączony, byle endpoint i model
   * były ustawione). Nie liczy się do żadnego przebiegu. Nigdy nie rzuca — wynik to dane.
   */
  async checkConnection(): Promise<LlmCheckResult> {
    let apiKey: string | null = null;
    let timeoutMs = 0;
    try {
      const cfg = await this.settings.loadCheckConfig();
      if (cfg.state === 'incomplete') {
        return { ok: false, error: 'Najpierw zapisz endpoint i model w Ustawieniach.' };
      }
      if (cfg.state === 'key_unreadable') {
        return {
          ok: false,
          error: 'Zapisanego klucza API nie da się odczytać (zmieniony SECRETS_ENCRYPTION_KEY) — wpisz go ponownie w Ustawieniach.',
        };
      }
      apiKey = cfg.endpoint.apiKey;
      timeoutMs = cfg.endpoint.timeoutMs;
      const result = await this.provider.chat(
        cfg.endpoint,
        [
          { role: 'system', content: 'Odpowiedz wyłącznie obiektem JSON.' },
          { role: 'user', content: 'Zwróć {"ok": true}' },
        ],
        { json: true },
      );
      const parsed = parseLlmJson(result.content, CHECK_SCHEMA);
      if (!parsed.ok) {
        return {
          ok: false,
          error: 'Endpoint nie zwrócił poprawnego JSON-a (response_format json_object) — sprawdź model i czy serwer wspiera ten tryb.',
        };
      }
      return {
        ok: true,
        model: result.model ?? cfg.endpoint.model,
        latencyMs: result.latencyMs,
        endpoint: cfg.endpoint.url,
        enabled: cfg.enabled,
      };
    } catch (err) {
      return { ok: false, error: redactSecret(describeCheckError(err, timeoutMs), apiKey) };
    }
  }
}
