-- Roadmap v1.6, „Provider LLM dla nocnego jobu" (ticket nightly-llm-provider, B1): ustawienia instancji
-- (tabela `llm_settings`) + dwie nowe wartości `audit_event_type`.
-- (1) `llm_settings` — konfiguracja kroku LLM w bazie, nie w env (G3–G7, G11, G14): wiersz instancji ma
--     `project_id IS NULL`; `UNIQUE NULLS NOT DISTINCT (project_id)` (Postgres 15+) pilnuje „najwyżej jeden na
--     projekt/instancję" i zostawia miejsce na późniejsze nadpisania per projekt bez zmiany schematu.
--     `api_key_ciphertext` to wyłącznie szyfrogram (AES-256-GCM, `SECRETS_ENCRYPTION_KEY`) — nigdy jawny klucz.
--     CHECK-i: cap 1..10000, timeout 1000..300000 ms, „włączony ⇒ endpoint i model".
-- (2) Wiersz instancji jest zasiewany tu (`id = 'global'`, domyślnie wyłączony): serwis robi `UPDATE …
--     WHERE project_id IS NULL`, a odczyty mają fallback na wartości domyślne, gdyby wiersza zabrakło.
-- UWAGA (55P04): drizzle stosuje wszystkie oczekujące migracje w JEDNEJ transakcji, a Postgres zabrania użycia
-- nowej wartości enuma w transakcji, która ją dodała. Dlatego ta migracja NIE używa `llm_secret_skipped` ani
-- `instance_settings_changed` (zasiew `llm_settings` ich nie dotyka) — pierwszy zapis audytu z tymi wartościami
-- dzieje się dopiero w aplikacji, po commicie migracji.
-- Nieodwracalna w części enumowej: Postgres nie ma `DROP VALUE` dla enuma (tabelę można `DROP TABLE`).
ALTER TYPE "public"."audit_event_type" ADD VALUE 'llm_secret_skipped';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'instance_settings_changed';--> statement-breakpoint
CREATE TABLE "llm_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"endpoint" text,
	"model" text,
	"api_key_ciphertext" text,
	"call_cap" integer DEFAULT 100 NOT NULL,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_settings_project_id_key" UNIQUE NULLS NOT DISTINCT("project_id"),
	CONSTRAINT "llm_settings_call_cap_check" CHECK ("llm_settings"."call_cap" BETWEEN 1 AND 10000),
	CONSTRAINT "llm_settings_timeout_ms_check" CHECK ("llm_settings"."timeout_ms" BETWEEN 1000 AND 300000),
	CONSTRAINT "llm_settings_enabled_complete_check" CHECK (NOT "llm_settings"."enabled" OR ("llm_settings"."endpoint" IS NOT NULL AND "llm_settings"."model" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "llm_settings" ADD CONSTRAINT "llm_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "llm_settings" ("id") VALUES ('global');
