import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { projects } from './projects';

/**
 * Ustawienia kroku LLM nocnego joba (roadmap v1.6, ticket `nightly-llm-provider`, G3–G7, G11, G14) —
 * konfiguracja żyje w bazie i w dashboardzie („Ustawienia"), NIE w env: zmiana modelu/endpointu/klucza
 * działa od następnego przebiegu bez redeployu.
 *
 * `project_id` (nullable, FK `projects`, ON DELETE CASCADE): `NULL` = wiersz instancji (jedyny, który
 * dziś istnieje — migracja zasiewa go z `id = 'global'`, domyślnie wyłączony). Model per projekt (poza
 * zakresem v1.6) to dodatkowe wiersze z `project_id` — pełne nadpisanie, nie łatka pól; bez zmian
 * schematu. `UNIQUE NULLS NOT DISTINCT (project_id)` gwarantuje najwyżej jeden wiersz instancji
 * i jeden na projekt.
 *
 * `api_key_ciphertext`: szyfrogram `v1:<iv>:<tag>:<ct>` (AES-256-GCM, `common/secret-box.ts`) — jawny
 * klucz nie trafia do bazy ani do `pg_dump`. Nigdy nie wychodzi przez REST (write-only, G6).
 *
 * CHECK-i dublują walidację serwisu (obrona w głębi): zakresy cap/timeout i spójność „włączony ⇒
 * endpoint i model" (G14) — niekompletna konfiguracja nie da się zapisać jako włączona nawet z pominięciem API.
 */
export const llmSettings = pgTable(
  'llm_settings',
  {
    id: text('id').primaryKey(), // 'global' dla wiersza instancji; llms_… dla przyszłych wierszy per projekt
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    endpoint: text('endpoint'),
    model: text('model'),
    apiKeyCiphertext: text('api_key_ciphertext'),
    callCap: integer('call_cap').notNull().default(100),
    timeoutMs: integer('timeout_ms').notNull().default(30000),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('llm_settings_project_id_key').on(t.projectId).nullsNotDistinct(),
    check('llm_settings_call_cap_check', sql`${t.callCap} BETWEEN 1 AND 10000`),
    check('llm_settings_timeout_ms_check', sql`${t.timeoutMs} BETWEEN 1000 AND 300000`),
    check(
      'llm_settings_enabled_complete_check',
      sql`NOT ${t.enabled} OR (${t.endpoint} IS NOT NULL AND ${t.model} IS NOT NULL)`,
    ),
  ],
);

export type LlmSettingsRow = typeof llmSettings.$inferSelect;
export type NewLlmSettingsRow = typeof llmSettings.$inferInsert;
