import 'reflect-metadata';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuditService } from '../src/audit/audit.service';
import { AppConfigService } from '../src/config/config.service';
import { envSchema } from '../src/config/env';
import type { Database } from '../src/db/db.tokens';
import * as schema from '../src/db/schema';
import { auditLog, llmSettings } from '../src/db/schema';
import { LLM_GLOBAL_SETTINGS_ID } from '../src/llm/llm.constants';
import { LlmHttpError, type LlmProvider } from '../src/llm/llm-provider';
import { LlmSettingsService } from '../src/llm/llm-settings.service';
import { LlmService } from '../src/llm/llm.service';
import type { LlmChatResult, LlmEndpoint, LlmSettingsUpdate } from '../src/llm/llm.types';

const KEY_A = Buffer.alloc(32, 11).toString('base64');
const KEY_B = Buffer.alloc(32, 22).toString('base64');
const SENTINEL = 'sk-sentinel-DO-NOT-LEAK-55555';

const BASE_UPDATE: LlmSettingsUpdate = {
  enabled: false,
  endpoint: null,
  model: null,
  callCap: 100,
  timeoutMs: 30000,
  apiKey: { action: 'keep' },
};

/** Provider-fake: zapisuje endpoint, z którym go wołano (dowód, że do niego dociera odszyfrowany klucz). */
function fakeProvider(behavior: () => LlmChatResult | Error): LlmProvider & { endpoints: LlmEndpoint[] } {
  const endpoints: LlmEndpoint[] = [];
  return {
    endpoints,
    async chat(endpoint) {
      endpoints.push(endpoint);
      const r = behavior();
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('LlmSettingsService + LlmService (integration, testcontainers) — roadmap v1.6', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let audit: AuditService;

  function services(secretsKey: string | undefined, provider: LlmProvider = fakeProvider(() => ({ content: '{"ok":true}', model: 'm-real', latencyMs: 12 }))) {
    const config = new AppConfigService(
      envSchema.parse({ DATABASE_URL: 'postgres://unused', ...(secretsKey ? { SECRETS_ENCRYPTION_KEY: secretsKey } : {}) }),
    );
    const settings = new LlmSettingsService(db, config, audit);
    return { settings, llm: new LlmService(settings, provider, audit) };
  }

  async function rawRow() {
    const [row] = await db.select().from(llmSettings).where(eq(llmSettings.id, LLM_GLOBAL_SETTINGS_ID));
    return row;
  }

  async function auditCount(eventType: 'instance_settings_changed'): Promise<number> {
    const rows = await db.select().from(auditLog).where(eq(auditLog.eventType, eventType));
    return rows.length;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18-trixie').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
    audit = new AuditService(db);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db
      .update(llmSettings)
      .set({ enabled: false, endpoint: null, model: null, apiKeyCiphertext: null, callCap: 100, timeoutMs: 30000 })
      .where(eq(llmSettings.id, LLM_GLOBAL_SETTINGS_ID));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('domyślnie: wiersz instancji wyłączony, bez klucza, wartości domyślne (G3/G11)', async () => {
    const dto = await services(KEY_A).settings.getPublic();
    expect(dto).toMatchObject({
      enabled: false,
      endpoint: null,
      model: null,
      callCap: 100,
      timeoutMs: 30000,
      apiKey: 'none',
      encryptionKeyConfigured: true,
    });
    expect(await services(undefined).settings.getPublic()).toMatchObject({ encryptionKeyConfigured: false });
    expect((await services(KEY_A).settings.loadRunConfig()).state).toBe('disabled');
  });

  it('G14: włączenie bez modelu/endpointu -> validation_error z czytelnym komunikatem, wiersz zostaje wyłączony', async () => {
    const { settings } = services(KEY_A);
    await expect(
      settings.update({ ...BASE_UPDATE, enabled: true, endpoint: null, model: 'm' }, 'human-dashboard'),
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('endpoint i model') });
    await expect(
      settings.update({ ...BASE_UPDATE, enabled: true, endpoint: 'https://x/v1/chat/completions', model: '   ' }, 'human-dashboard'),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect((await rawRow()).enabled).toBe(false);
  });

  it('endpoint z loginem/hasłem w URL-u albo nie-http(s) -> validation_error', async () => {
    const { settings } = services(KEY_A);
    for (const endpoint of ['https://user:pass@host/v1/chat/completions', 'ftp://host/x', 'nie-url']) {
      await expect(settings.update({ ...BASE_UPDATE, endpoint }, 'human-dashboard')).rejects.toMatchObject({
        code: 'validation_error',
      });
    }
    // komunikat nie interpoluje wejścia
    await expect(
      settings.update({ ...BASE_UPDATE, endpoint: `https://u:${SENTINEL}@h/x` }, 'human-dashboard'),
    ).rejects.toSatisfy((e: Error) => !e.message.includes(SENTINEL));
  });

  it('G5: zapis klucza bez SECRETS_ENCRYPTION_KEY -> validation_error wspominający zmienną; nic się nie zapisuje', async () => {
    const { settings } = services(undefined);
    const before = await auditCount('instance_settings_changed');
    await expect(
      settings.update({ ...BASE_UPDATE, apiKey: { action: 'set', value: SENTINEL } }, 'human-dashboard'),
    ).rejects.toSatisfy((e: Error & { code?: string }) => e.code === 'validation_error' && e.message.includes('SECRETS_ENCRYPTION_KEY') && !e.message.includes(SENTINEL));
    expect((await rawRow()).apiKeyCiphertext).toBeNull();
    expect(await auditCount('instance_settings_changed')).toBe(before);
    // sama konfiguracja bez klucza zapisuje się normalnie (appka działa bez SECRETS_ENCRYPTION_KEY)
    const dto = await settings.update(
      { ...BASE_UPDATE, enabled: true, endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3' },
      'human-dashboard',
    );
    expect(dto).toMatchObject({ enabled: true, apiKey: 'none', encryptionKeyConfigured: false });
  });

  it('klucz API: w bazie wyłącznie szyfrogram v1:…, DTO mówi tylko "set", audyt bez klucza (G4/G6)', async () => {
    const { settings } = services(KEY_A);
    const before = await auditCount('instance_settings_changed');

    const dto = await settings.update(
      {
        enabled: true,
        endpoint: 'https://api.example.com/v1/chat/completions',
        model: 'gpt-x',
        callCap: 50,
        timeoutMs: 20000,
        apiKey: { action: 'set', value: `  ${SENTINEL}  ` },
      },
      'human-dashboard',
    );

    const row = await rawRow();
    expect(row.apiKeyCiphertext).toMatch(/^v1:/);
    expect(row.apiKeyCiphertext).not.toContain(SENTINEL);
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
    expect(dto).toMatchObject({ enabled: true, apiKey: 'set', callCap: 50, timeoutMs: 20000, model: 'gpt-x' });
    expect(JSON.stringify(dto)).not.toContain(SENTINEL);
    expect(JSON.stringify(await settings.getPublic())).not.toContain(SENTINEL);

    // przebieg dostaje odszyfrowany, przycięty klucz — tylko w pamięci procesu
    const cfg = await settings.loadRunConfig();
    expect(cfg).toMatchObject({ state: 'ready', callCap: 50 });
    if (cfg.state === 'ready') expect(cfg.endpoint.apiKey).toBe(SENTINEL);

    // audyt: jedno nowe zdarzenie, klucz tylko jako 'set'
    expect(await auditCount('instance_settings_changed')).toBe(before + 1);
    const events = await db.select().from(auditLog).where(eq(auditLog.eventType, 'instance_settings_changed'));
    const last = events[events.length - 1];
    expect(last.actor).toBe('human-dashboard');
    expect(last.metadata).toMatchObject({
      section: 'llm',
      changes: { enabled: { from: false, to: true }, model: { from: null, to: 'gpt-x' }, apiKey: 'set' },
    });
    // żaden wiersz audytu nie zawiera klucza
    const allAudit = await db.select().from(auditLog);
    expect(JSON.stringify(allAudit)).not.toContain(SENTINEL);
  });

  it('keep zachowuje szyfrogram, clear go kasuje (z audytem "cleared"), brak zmian = brak audytu', async () => {
    const { settings } = services(KEY_A);
    await settings.update(
      { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'm', apiKey: { action: 'set', value: SENTINEL } },
      'human-dashboard',
    );
    const ciphertext = (await rawRow()).apiKeyCiphertext;

    const afterKeepCount = await auditCount('instance_settings_changed');
    await settings.update(
      { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'm', apiKey: { action: 'keep' } },
      'human-dashboard',
    );
    expect((await rawRow()).apiKeyCiphertext).toBe(ciphertext);
    expect(await auditCount('instance_settings_changed')).toBe(afterKeepCount); // nic się nie zmieniło

    const dto = await settings.update(
      { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'm', apiKey: { action: 'clear' } },
      'human-dashboard',
    );
    expect((await rawRow()).apiKeyCiphertext).toBeNull();
    expect(dto.apiKey).toBe('none');
    const events = await db.select().from(auditLog).where(eq(auditLog.eventType, 'instance_settings_changed'));
    expect(events[events.length - 1].metadata).toMatchObject({ changes: { apiKey: 'cleared' } });
  });

  it('G7: serwis z INNYM kluczem szyfrującym -> apiKey "unreadable", loadRunConfig key_unreadable; zapis "keep" nie niszczy szyfrogramu', async () => {
    await services(KEY_A).settings.update(
      { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'm', apiKey: { action: 'set', value: SENTINEL } },
      'human-dashboard',
    );
    const ciphertext = (await rawRow()).apiKeyCiphertext;

    const other = services(KEY_B);
    expect((await other.settings.getPublic()).apiKey).toBe('unreadable');
    expect(await other.settings.loadRunConfig()).toEqual({ state: 'key_unreadable' });
    const budget = await other.llm.openRunBudget('nightly');
    expect(budget.state).toBe('key_unreadable');

    await other.settings.update(
      { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'm2', apiKey: { action: 'keep' } },
      'human-dashboard',
    );
    expect((await rawRow()).apiKeyCiphertext).toBe(ciphertext);

    // ponowne wpisanie klucza naprawia stan
    await other.settings.update(
      { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'm2', apiKey: { action: 'set', value: 'sk-nowy' } },
      'human-dashboard',
    );
    expect((await other.settings.getPublic()).apiKey).toBe('set');
  });

  it('G7: szyfrogram w bazie, ale serwer BEZ SECRETS_ENCRYPTION_KEY -> "unreadable"', async () => {
    await services(KEY_A).settings.update(
      { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'm', apiKey: { action: 'set', value: SENTINEL } },
      'human-dashboard',
    );
    const noKey = services(undefined);
    expect(await noKey.settings.getPublic()).toMatchObject({ apiKey: 'unreadable', encryptionKeyConfigured: false });
    expect(await noKey.settings.loadRunConfig()).toEqual({ state: 'key_unreadable' });
  });

  it('bez redeployu: po update świeże loadRunConfig() widzi nowy model na TEJ SAMEJ instancji serwisu', async () => {
    const { settings } = services(KEY_A);
    await settings.update({ ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'model-1' }, 'human-dashboard');
    const first = await settings.loadRunConfig();
    expect(first.state === 'ready' && first.endpoint.model).toBe('model-1');

    await settings.update({ ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'model-2' }, 'human-dashboard');
    const second = await settings.loadRunConfig();
    expect(second.state === 'ready' && second.endpoint.model).toBe('model-2');
  });

  it('openRunBudget: włączony -> budżet ready z limitem z ustawień; wyłączony -> disabled', async () => {
    const { settings, llm } = services(KEY_A);
    expect((await llm.openRunBudget('nightly')).state).toBe('disabled');
    await settings.update({ ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'm', callCap: 2 }, 'human-dashboard');
    const budget = await llm.openRunBudget('nightly');
    expect(budget.state).toBe('ready');
    const schema = z.object({ ok: z.boolean() });
    const call = () => budget.call({ purpose: 't', sources: [], messages: [{ role: 'user', content: 'x' }], schema });
    expect((await call()).ok).toBe(true);
    expect((await call()).ok).toBe(true);
    expect(await call()).toEqual({ ok: false, reason: 'cap' });
  });

  describe('checkConnection ("Sprawdź połączenie" / CLI check-llm)', () => {
    it('działający endpoint -> ok + model + latencja + endpoint; klucz dociera do providera, nie do wyniku', async () => {
      const provider = fakeProvider(() => ({ content: '{"ok":true}', model: 'gpt-real-1', latencyMs: 412 }));
      const { settings, llm } = services(KEY_A, provider);
      await settings.update(
        { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'gpt', apiKey: { action: 'set', value: SENTINEL } },
        'human-dashboard',
      );

      const result = await llm.checkConnection();

      expect(result).toEqual({ ok: true, model: 'gpt-real-1', latencyMs: 412, endpoint: 'https://a/v1/chat/completions', enabled: true });
      expect(provider.endpoints[0].apiKey).toBe(SENTINEL);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    });

    it('używa ZAPISANEJ konfiguracji także gdy krok jest wyłączony (enabled=false w wyniku)', async () => {
      const { settings, llm } = services(KEY_A);
      await settings.update({ ...BASE_UPDATE, enabled: false, endpoint: 'https://a/v1/chat/completions', model: 'gpt' }, 'human-dashboard');
      expect(await llm.checkConnection()).toMatchObject({ ok: true, enabled: false });
    });

    it('brak endpointu/modelu -> czytelny błąd, provider niewołany', async () => {
      const provider = fakeProvider(() => ({ content: '{}', model: null, latencyMs: 1 }));
      const result = await services(KEY_A, provider).llm.checkConnection();
      expect(result.ok).toBe(false);
      expect(provider.endpoints).toHaveLength(0);
    });

    it.each([
      [401, 'klucz API'],
      [404, '/chat/completions'],
      [500, 'HTTP 500'],
    ])('HTTP %i -> czytelny komunikat po polsku bez klucza', async (status, fragment) => {
      const provider = fakeProvider(() => new LlmHttpError(status, null));
      const { settings, llm } = services(KEY_A, provider);
      await settings.update(
        { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'gpt', apiKey: { action: 'set', value: SENTINEL } },
        'human-dashboard',
      );

      const result = await llm.checkConnection();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(fragment);
        expect(result.error).not.toContain(SENTINEL);
      }
    });

    it('odpowiedź nie-JSON -> komunikat o response_format json_object', async () => {
      const provider = fakeProvider(() => ({ content: 'Hello!', model: 'm', latencyMs: 1 }));
      const { settings, llm } = services(KEY_A, provider);
      await settings.update({ ...BASE_UPDATE, endpoint: 'https://a/v1/chat/completions', model: 'gpt' }, 'human-dashboard');
      const result = await llm.checkConnection();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('json_object');
    });

    it('nieczytelny klucz -> komunikat "wpisz go ponownie", provider niewołany', async () => {
      await services(KEY_A).settings.update(
        { ...BASE_UPDATE, endpoint: 'https://a/v1/chat/completions', model: 'gpt', apiKey: { action: 'set', value: SENTINEL } },
        'human-dashboard',
      );
      const provider = fakeProvider(() => ({ content: '{}', model: null, latencyMs: 1 }));
      const result = await services(KEY_B, provider).llm.checkConnection();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('wpisz go ponownie');
      expect(provider.endpoints).toHaveLength(0);
    });

    it('nieoczekiwany wyjątek providera nie wycieka — wynik to dane', async () => {
      const provider = fakeProvider(() => new Error(`boom ${SENTINEL}`));
      const { settings, llm } = services(KEY_A, provider);
      await settings.update({ ...BASE_UPDATE, endpoint: 'https://a/v1/chat/completions', model: 'gpt' }, 'human-dashboard');
      const result = await llm.checkConnection();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    });
  });

  it('sentinel sweep: klucz nie pojawia się w żadnym logu ani w console przez cały cykl życia', async () => {
    const captured: string[] = [];
    const capture = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      vi.spyOn(Logger.prototype, m).mockImplementation(capture);
    }
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(capture);
    }

    const failing = fakeProvider(() => new LlmHttpError(500, null));
    const { settings, llm } = services(KEY_A, failing);
    await settings.update(
      { ...BASE_UPDATE, enabled: true, endpoint: 'https://a/v1/chat/completions', model: 'm', apiKey: { action: 'set', value: SENTINEL } },
      'human-dashboard',
    );
    await settings.getPublic();
    await llm.checkConnection();
    const budget = await llm.openRunBudget('nightly');
    await budget.call({ purpose: 't', sources: [{ memoryId: 'mem_1', text: 'tekst' }], messages: [{ role: 'user', content: 'x' }], schema: z.object({}) });
    await settings
      .update({ ...BASE_UPDATE, enabled: true, endpoint: null, model: null, apiKey: { action: 'set', value: SENTINEL } }, 'human-dashboard')
      .catch(() => undefined);
    await services(KEY_B).llm.checkConnection();
    await services(undefined).settings.update({ ...BASE_UPDATE, apiKey: { action: 'set', value: SENTINEL } }, 'human-dashboard').catch(() => undefined);

    expect(captured.some((line) => line.includes('[llm]'))).toBe(true); // sweep faktycznie coś złapał
    expect(captured.filter((line) => line.includes(SENTINEL))).toEqual([]);
  });
});
