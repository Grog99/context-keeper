CREATE TABLE "search_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"result_count" integer NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_events_project_created_idx" ON "search_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "search_events_created_idx" ON "search_events" USING btree ("created_at");