ALTER TYPE "public"."memory_kind" ADD VALUE 'event';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "include_events_in_default_search" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "event_time" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "memories_event_time_idx" ON "memories" USING btree ("event_time");