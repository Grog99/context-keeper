CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."audit_event_type" AS ENUM('proposal_created', 'proposal_approved', 'proposal_rejected', 'proposal_edited', 'human_edit', 'archive', 'promote', 'token_created', 'token_rotated', 'secret_blocked', 'purge_tombstone', 'nightly_run');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('fact', 'document');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('global', 'project');--> statement-breakpoint
CREATE TYPE "public"."memory_source" AS ENUM('agent', 'human', 'nightly');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('approved', 'archived');--> statement-breakpoint
CREATE TYPE "public"."project_token_status" AS ENUM('none', 'active', 'rotated');--> statement-breakpoint
CREATE TYPE "public"."proposal_origin" AS ENUM('agent', 'human', 'nightly');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."proposal_type" AS ENUM('create', 'update', 'merge', 'delete');--> statement-breakpoint
CREATE TYPE "public"."revision_action" AS ENUM('created', 'edited', 'promote', 'archive', 'superseded_by');--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"token_status" "project_token_status" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"header" text NOT NULL,
	"body" text NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"project_id" text,
	"status" "memory_status" DEFAULT 'approved' NOT NULL,
	"source" "memory_source" NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"chunk_text" text NOT NULL,
	"embedding_model" text NOT NULL,
	"vector" vector(1024)
);
--> statement-breakpoint
CREATE TABLE "staging_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"chunk_text" text NOT NULL,
	"embedding_model" text NOT NULL,
	"vector" vector(1024)
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "proposal_type" NOT NULL,
	"origin" "proposal_origin" NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"affected_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"base_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text,
	"scope" "memory_scope" NOT NULL,
	"project_id" text,
	"confidence" double precision,
	"auto_eligible" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"action" "revision_action" NOT NULL,
	"actor" text NOT NULL,
	"snapshot" jsonb,
	"supersedes" text,
	"superseded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" "audit_event_type" NOT NULL,
	"actor" text NOT NULL,
	"affected_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"revision_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_embeddings" ADD CONSTRAINT "staging_embeddings_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_token_hash_key" ON "projects" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "projects_name_idx" ON "projects" USING btree ("name");--> statement-breakpoint
CREATE INDEX "memories_project_idx" ON "memories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "memories_kind_idx" ON "memories" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "memories_status_idx" ON "memories" USING btree ("status");--> statement-breakpoint
CREATE INDEX "memories_scope_idx" ON "memories" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "embeddings_memory_idx" ON "embeddings" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "embeddings_model_idx" ON "embeddings" USING btree ("embedding_model");--> statement-breakpoint
CREATE INDEX "staging_embeddings_proposal_idx" ON "staging_embeddings" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proposals_origin_idx" ON "proposals" USING btree ("origin");--> statement-breakpoint
CREATE INDEX "proposals_project_idx" ON "proposals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "proposals_content_hash_idx" ON "proposals" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "revisions_memory_idx" ON "revisions" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "audit_event_type_idx" ON "audit_log" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor");--> statement-breakpoint
--> Hybrid retrieval (§6): FTS (tsvector, konfiguracja `simple` — bez stemmingu, żeby nie masakrować PL/EN)
--> oraz indeks wektorowy HNSW. Poza zasięgiem drizzle-kit → utrzymywane ręcznie w tej migracji.
ALTER TABLE "memories" ADD COLUMN "fts" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("header", '') || ' ' || coalesce("body", ''))) STORED;--> statement-breakpoint
CREATE INDEX "memories_fts_idx" ON "memories" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "embeddings_vector_hnsw_idx" ON "embeddings" USING hnsw ("vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "staging_embeddings_vector_hnsw_idx" ON "staging_embeddings" USING hnsw ("vector" vector_cosine_ops);