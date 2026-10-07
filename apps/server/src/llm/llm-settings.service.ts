import { Inject, Injectable } from '@nestjs/common';
import { eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { ToolError } from '../common/errors';
import { createSecretBox, type SecretBox } from '../common/secret-box';
import { AppConfigService } from '../config/config.service';
import { DB, type Database } from '../db/db.tokens';
import { llmSettings, type LlmSettingsRow } from '../db/schema';
import {
  LLM_API_KEY_AAD,
  LLM_CALL_CAP_MAX,
  LLM_CALL_CAP_MIN,
  LLM_DEFAULT_CALL_CAP,
  LLM_DEFAULT_TIMEOUT_MS,
  LLM_GLOBAL_SETTINGS_ID,
  LLM_TIMEOUT_MAX_MS,
  LLM_TIMEOUT_MIN_MS,
} from './llm.constants';
import type { LlmApiKeyState, LlmEndpoint, LlmSettingsDto, LlmSettingsUpdate } from './llm.types';

/** Konfiguracja potrzebna przebiegowi nocnego joba — `ready` niesie już odszyfrowany klucz (tylko w pamięci procesu). */
export type LlmRunConfig =
  | { state: 'disabled' }
  | { state: 'key_unreadable' }
  | { state: 'ready'; endpoint: LlmEndpoint; callCap: number };

/** Konfiguracja dla „Sprawdź połączenie" / `check-llm`: ZAPISANA konfiguracja, także gdy krok jest wyłączony. */
export type LlmCheckConfig =
  | { state: 'incomplete' }
  | { state: 'key_unreadable' }
  | { state: 'ready'; endpoint: LlmEndpoint; enabled: boolean };

/** `http(s)://…` bez loginu i hasła w URL-u (klucz idzie nagłówkiem, a URL ląduje w audycie i odpowiedzi). */
export function isValidLlmEndpointUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Ustawienia kroku LLM (roadmap v1.6, G3–G7, G11, G14): odczyt/zapis wiersza instancji `llm_settings`.
 * Konfiguracja jest czytana PER PRZEBIEG (bez cache'u), więc zmiana w „Ustawieniach" działa od następnego
 * przebiegu — i w procesie HTTP, i w CLI — bez redeployu.
 *
 * Klucz API: w bazie wyłącznie szyfrogram (`SecretBox`, `SECRETS_ENCRYPTION_KEY`), w REST write-only (G6) —
 * DTO niesie tylko `apiKey: 'none' | 'set' | 'unreadable'`. Komunikaty błędów są STAŁE: nigdy nie
 * interpolujemy wejścia użytkownika (mogłoby nieść klucz) do wyjątków, które Nest/pino zalogują.
 */
@Injectable()
export class LlmSettingsService {
  private readonly box: SecretBox;

  constructor(
    @Inject(DB) private readonly db: Database,
    config: AppConfigService,
    private readonly audit: AuditService,
  ) {
    this.box = createSecretBox(config.get('SECRETS_ENCRYPTION_KEY'));
  }

  async getPublic(projectId: string | null = null): Promise<LlmSettingsDto> {
    const row = await this.loadRow(projectId);
    return {
      enabled: row?.enabled ?? false,
      endpoint: row?.endpoint ?? null,
      model: row?.model ?? null,
      callCap: row?.callCap ?? LLM_DEFAULT_CALL_CAP,
      timeoutMs: row?.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS,
      apiKey: this.apiKeyState(row),
      encryptionKeyConfigured: this.box.configured,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /**
   * Zapis ustawień instancji. Walidacja (400 `validation_error`, stałe komunikaty):
   * G14 — włączenie wymaga endpointu i modelu; G5 — zapis klucza wymaga `SECRETS_ENCRYPTION_KEY`.
   * Audyt `instance_settings_changed` (bez klucza — `apiKey` tylko `set`/`cleared`) w jednej transakcji z
   * zapisem; pomijany, gdy nic się nie zmieniło.
   */
  async update(input: LlmSettingsUpdate, actor: string): Promise<LlmSettingsDto> {
    const endpoint = blankToNull(input.endpoint);
    const model = blankToNull(input.model);

    if (input.enabled && (!endpoint || !model)) {
      throw new ToolError('validation_error', 'Aby włączyć krok LLM, podaj endpoint i model.');
    }
    if (endpoint !== null && !isValidLlmEndpointUrl(endpoint)) {
      throw new ToolError('validation_error', 'Endpoint musi być adresem http(s):// bez loginu i hasła w URL-u.');
    }
    if (!Number.isInteger(input.callCap) || input.callCap < LLM_CALL_CAP_MIN || input.callCap > LLM_CALL_CAP_MAX) {
      throw new ToolError(
        'validation_error',
        `Limit wywołań na przebieg musi być liczbą całkowitą od ${LLM_CALL_CAP_MIN} do ${LLM_CALL_CAP_MAX}.`,
      );
    }
    if (
      !Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < LLM_TIMEOUT_MIN_MS ||
      input.timeoutMs > LLM_TIMEOUT_MAX_MS
    ) {
      throw new ToolError(
        'validation_error',
        `Timeout musi być liczbą całkowitą z zakresu ${LLM_TIMEOUT_MIN_MS}–${LLM_TIMEOUT_MAX_MS} ms.`,
      );
    }
    let newKey: string | null = null;
    if (input.apiKey.action === 'set') {
      if (!this.box.configured) {
        throw new ToolError(
          'validation_error',
          'Serwer nie ma SECRETS_ENCRYPTION_KEY — klucza API nie da się zapisać. Ustaw zmienną w env i zrestartuj aplikację.',
        );
      }
      newKey = input.apiKey.value.trim();
      if (newKey === '') {
        throw new ToolError('validation_error', 'Klucz API nie może być pusty.');
      }
    }

    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(llmSettings).where(isNull(llmSettings.projectId)).limit(1);

      let ciphertext = existing?.apiKeyCiphertext ?? null;
      let apiKeyChange: 'set' | 'cleared' | null = null;
      if (input.apiKey.action === 'set' && newKey !== null) {
        ciphertext = this.box.encrypt(newKey, LLM_API_KEY_AAD);
        apiKeyChange = 'set';
      } else if (input.apiKey.action === 'clear' && ciphertext !== null) {
        ciphertext = null;
        apiKeyChange = 'cleared';
      }

      const next = { enabled: input.enabled, endpoint, model, callCap: input.callCap, timeoutMs: input.timeoutMs };
      const before = {
        enabled: existing?.enabled ?? false,
        endpoint: existing?.endpoint ?? null,
        model: existing?.model ?? null,
        callCap: existing?.callCap ?? LLM_DEFAULT_CALL_CAP,
        timeoutMs: existing?.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS,
      };
      const changes: Record<string, unknown> = {};
      for (const field of ['enabled', 'endpoint', 'model', 'callCap', 'timeoutMs'] as const) {
        if (before[field] !== next[field]) changes[field] = { from: before[field], to: next[field] };
      }
      if (apiKeyChange) changes.apiKey = apiKeyChange;

      // Upsert po stałym id wiersza instancji: migracja go zasiewa, ale brak wiersza nie może blokować zapisu.
      await tx
        .insert(llmSettings)
        .values({ id: LLM_GLOBAL_SETTINGS_ID, projectId: null, ...next, apiKeyCiphertext: ciphertext })
        .onConflictDoUpdate({
          target: llmSettings.id,
          set: { ...next, apiKeyCiphertext: ciphertext, updatedAt: new Date() },
        });

      if (Object.keys(changes).length > 0) {
        await this.audit.log(
          { eventType: 'instance_settings_changed', actor, metadata: { section: 'llm', changes } },
          tx,
        );
      }
    });

    return this.getPublic();
  }

  /** Konfiguracja do przebiegu nocnego joba (jeden SELECT, bez cache'u). Rzuca tylko przy awarii bazy —
   * wołający (`LlmService.openRunBudget`) zamienia to w stan `unavailable` (fail-open). */
  async loadRunConfig(projectId: string | null = null): Promise<LlmRunConfig> {
    const row = await this.loadRow(projectId);
    if (!row || !row.enabled || !row.endpoint || !row.model) return { state: 'disabled' };
    const key = this.resolveApiKey(row);
    if (key === 'unreadable') return { state: 'key_unreadable' };
    return {
      state: 'ready',
      callCap: row.callCap,
      endpoint: { url: row.endpoint, model: row.model, apiKey: key, timeoutMs: row.timeoutMs },
    };
  }

  /** Zapisana konfiguracja do „Sprawdź połączenie" — niezależnie od przełącznika `enabled`. */
  async loadCheckConfig(projectId: string | null = null): Promise<LlmCheckConfig> {
    const row = await this.loadRow(projectId);
    if (!row || !row.endpoint || !row.model) return { state: 'incomplete' };
    const key = this.resolveApiKey(row);
    if (key === 'unreadable') return { state: 'key_unreadable' };
    return {
      state: 'ready',
      enabled: row.enabled,
      endpoint: { url: row.endpoint, model: row.model, apiKey: key, timeoutMs: row.timeoutMs },
    };
  }

  /** Wiersz projektu (jeśli `projectId` podany i wiersz istnieje) ma pierwszeństwo jako PEŁNE nadpisanie;
   * w przeciwnym razie wiersz instancji (`project_id IS NULL`). B1 tworzy wyłącznie wiersz instancji —
   * wiersze per projekt to późniejsze rozszerzenie (G3), schemat już je dopuszcza. */
  private async loadRow(projectId: string | null): Promise<LlmSettingsRow | null> {
    if (projectId !== null) {
      const [own] = await this.db.select().from(llmSettings).where(eq(llmSettings.projectId, projectId)).limit(1);
      if (own) return own;
    }
    const [row] = await this.db.select().from(llmSettings).where(isNull(llmSettings.projectId)).limit(1);
    return row ?? null;
  }

  /** Odszyfrowany klucz, `null` (brak klucza) albo `'unreadable'` (G7: zły tag GCM, zły format, brak `SECRETS_ENCRYPTION_KEY`). */
  private resolveApiKey(row: LlmSettingsRow): string | null | 'unreadable' {
    if (row.apiKeyCiphertext === null) return null;
    const dec = this.box.decrypt(row.apiKeyCiphertext, LLM_API_KEY_AAD);
    return dec.ok ? dec.value : 'unreadable';
  }

  private apiKeyState(row: LlmSettingsRow | null): LlmApiKeyState {
    if (!row || row.apiKeyCiphertext === null) return 'none';
    return this.box.decrypt(row.apiKeyCiphertext, LLM_API_KEY_AAD).ok ? 'set' : 'unreadable';
  }
}
