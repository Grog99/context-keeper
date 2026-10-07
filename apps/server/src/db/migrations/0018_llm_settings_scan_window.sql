-- Roadmap v1.6, B2 „Lepszy prune w nocnym jobie" (ticket nightly-llm-prune, G6): kolumna
-- `llm_settings.scan_window_days` — szerokość okna przeglądu detektorów LLM (po `memories.created_at`),
-- domyślnie 1 dzień, zakres 1–365 (CHECK dubluje LLM_SCAN_WINDOW_MIN_DAYS/MAX_DAYS z `llm.constants.ts`).
-- ADD COLUMN ze stałym DEFAULT i NOT NULL to zmiana wyłącznie metadanych (PG11+, bez przepisywania tabeli);
-- istniejący wiersz instancji (`id = 'global'`) dostaje 1. ADD CONSTRAINT waliduje istniejące wiersze (wszystkie = 1).
-- Brak zmian enumów, więc problem 55P04 (nowa wartość enuma w tej samej transakcji) nie dotyczy tej migracji.
-- Odwracalna: `ALTER TABLE "llm_settings" DROP CONSTRAINT "llm_settings_scan_window_days_check"`, a potem
-- `ALTER TABLE "llm_settings" DROP COLUMN "scan_window_days"`.
ALTER TABLE "llm_settings" ADD COLUMN "scan_window_days" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_settings" ADD CONSTRAINT "llm_settings_scan_window_days_check" CHECK ("llm_settings"."scan_window_days" BETWEEN 1 AND 365);
