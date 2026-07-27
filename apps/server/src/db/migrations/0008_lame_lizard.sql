CREATE TYPE "public"."relation_type" AS ENUM('caused_by', 'follows', 'context_for');--> statement-breakpoint
CREATE TABLE "memory_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"from_memory_id" text NOT NULL,
	"to_memory_id" text NOT NULL,
	"type" "relation_type" NOT NULL,
	"project_id" text NOT NULL,
	"source" "memory_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_relations_no_self_loop" CHECK ("memory_relations"."from_memory_id" <> "memory_relations"."to_memory_id")
);
--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_from_memory_id_memories_id_fk" FOREIGN KEY ("from_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_to_memory_id_memories_id_fk" FOREIGN KEY ("to_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_relations_from_to_type_key" ON "memory_relations" USING btree ("from_memory_id","to_memory_id","type");--> statement-breakpoint
CREATE INDEX "memory_relations_from_idx" ON "memory_relations" USING btree ("from_memory_id");--> statement-breakpoint
CREATE INDEX "memory_relations_to_idx" ON "memory_relations" USING btree ("to_memory_id");--> statement-breakpoint
CREATE INDEX "memory_relations_project_idx" ON "memory_relations" USING btree ("project_id");
