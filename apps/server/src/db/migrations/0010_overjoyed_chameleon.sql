CREATE TYPE "public"."project_token_state" AS ENUM('active', 'grace', 'revoked');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'token_revoked' BEFORE 'secret_blocked';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'token_relabeled' BEFORE 'secret_blocked';--> statement-breakpoint
CREATE TABLE "project_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"status" "project_token_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"grace_started_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "search_events" ADD COLUMN "token_id" text;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_tokens_token_hash_key" ON "project_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "project_tokens_project_idx" ON "project_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tokens_project_label_active_key" ON "project_tokens" USING btree ("project_id","label") WHERE "project_tokens"."status" = 'active';--> statement-breakpoint
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_token_id_project_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."project_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Data backfill (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation" — plan §2 krok B3):
-- MUSI biec dokładnie TUTAJ — `project_tokens` (+ jego FK/indeksy) już istnieje, ale `projects`
-- jeszcze niesie `token_hash`/`token_rotated_at` (usuwane niżej). Odwrócenie kolejności (INSERT po
-- DROP COLUMN) cicho zniszczyłoby wszystkie tokeny sprzed migracji — SELECT zwróciłby same NULL-e
-- w WHERE, insert nic by nie wstawił. Etykieta zmigrowanych tokenów = `'legacy'` (locked decision
-- planu §0 pkt 6). Losowy `tok_…` id budowany bez zależności na aplikacyjnym `generateId` (migracja
-- jest czystym SQL, bez node runtime) — `md5(random()::text || clock_timestamp()::text || …)`
-- daje wystarczającą unikalność dla jednorazowego backfillu (nie jest to ścieżka produkcyjnego
-- mintowania tokenów, ta zostaje w `common/tokens.ts`/`common/ids.ts`).
INSERT INTO "project_tokens"
  ("id","project_id","token_hash","label","status","created_at")
SELECT
  'tok_' || substr(md5(random()::text || clock_timestamp()::text || p."id"), 1, 12),
  p."id", p."token_hash", 'legacy', 'active',
  COALESCE(p."token_rotated_at", p."created_at")
FROM "projects" p
WHERE p."token_hash" IS NOT NULL;--> statement-breakpoint
DROP INDEX "projects_token_hash_key";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "token_status";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "token_rotated_at";--> statement-breakpoint
DROP TYPE "public"."project_token_status";
