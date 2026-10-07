-- Roadmap v1.6, A2 „Auto mode per projekt + bezpieczniki" (ticket auto-mode): pięć nowych kolumn, dwa
-- indeksy częściowe i trzy CHECK-i.
-- (1) `projects.auto_mode` (DEFAULT false) i `projects.auto_mode_daily_limit` (DEFAULT 50, CHECK 1..10000) —
--     przełącznik i limit (c) bezpiecznika; istniejące projekty zostają z wyłączonym auto mode i limitem 50.
-- (2) `proposals.auto_hold_reasons text[]` — powody zawrócenia zapisu do kolejki (zbiór zamknięty, CHECK; NULL =
--     nic nie zawrócono) oraz `proposals.auto_approved_at` — kiedy zatwierdziła maszyna (CHECK: nigdy oba naraz).
-- (3) `memories.auto_approved_at` — „bieżąca treść weszła przez auto mode" (zdejmowane przy zmianie przez człowieka).
-- Powody są `text[]` + CHECK, nie enumem, i migracja nie dodaje żadnej wartości enuma — brak ryzyka 55P04
-- (zob. komentarz w 0017). ADD COLUMN z DEFAULT-stałą NOT NULL to zmiana wyłącznie metadanych (PG11+), nullable
-- ADD COLUMN też; istniejące wiersze `proposals`/`memories` zostają NULL (bez backfillu).
-- Odwracalna: DROP CONSTRAINT / DROP INDEX / `ALTER TABLE … DROP COLUMN` dla każdej z pięciu kolumn.
ALTER TABLE "projects" ADD COLUMN "auto_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_mode_daily_limit" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "auto_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "auto_hold_reasons" text[];--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "auto_approved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "memories_auto_approved_at_idx" ON "memories" USING btree ("auto_approved_at") WHERE "memories"."auto_approved_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "proposals_project_auto_approved_idx" ON "proposals" USING btree ("project_id","auto_approved_at") WHERE "proposals"."auto_approved_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_auto_mode_daily_limit_check" CHECK ("projects"."auto_mode_daily_limit" BETWEEN 1 AND 10000);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_auto_hold_reasons_check" CHECK ("proposals"."auto_hold_reasons" IS NULL OR (cardinality("proposals"."auto_hold_reasons") > 0 AND "proposals"."auto_hold_reasons" <@ ARRAY['near_duplicate','not_computed','human_target','daily_limit','auto_failed']::text[]));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_auto_state_check" CHECK ("proposals"."auto_approved_at" IS NULL OR "proposals"."auto_hold_reasons" IS NULL);