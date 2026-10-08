-- Roadmap v1.6, A3+A4 „Nadzór po fakcie: cofanie i pomiary auto mode" (ticket auto-mode-oversight): jedna nowa
-- kolumna, jeden FK, jeden indeks częściowy i backfill.
-- (1) `proposals.token_id` (nullable, FK -> `project_tokens(id)` ON DELETE SET NULL) — token zapisu `save_memory`
--     (create/update), nośnik filtra „po tokenie" w cofaniu auto mode (G1b). Dotąd token żył wyłącznie w
--     `audit_log.metadata` zdarzenia `proposal_created` (bez indeksu).
-- (2) `proposals_project_auto_held_idx (project_id, created_at) WHERE auto_hold_reasons IS NOT NULL` — statystyka
--     powodów zawrócenia (A4) per projekt w zakresie czasu.
-- (3) Backfill `token_id` z audytu `proposal_created` (`metadata->>'proposalId'` / `metadata->>'tokenId'`) — tylko dla
--     `origin='agent'` + `type IN ('create','update')` i tylko gdy token nadal istnieje (inaczej FK by pękł).
--     Propozycje nocnego joba i `create_project` zostają NULL.
-- Migracja nie dodaje wartości enuma (brak ryzyka 55P04, zob. komentarz w 0017). Nullable ADD COLUMN to zmiana
-- wyłącznie metadanych; indeks zwykły (nie CONCURRENTLY — drizzle stosuje migracje w jednej transakcji) na małej
-- tabeli częściowej. Backfill to jednorazowy hash-join `proposals` x `audit_log` po `proposalId`; błąd cofa całą
-- migrację. Odwracalna: DROP INDEX / DROP CONSTRAINT / `ALTER TABLE … DROP COLUMN`.
ALTER TABLE "proposals" ADD COLUMN "token_id" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_token_id_project_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."project_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_project_auto_held_idx" ON "proposals" USING btree ("project_id","created_at") WHERE "proposals"."auto_hold_reasons" IS NOT NULL;--> statement-breakpoint
UPDATE "proposals" AS p SET "token_id" = a."metadata" ->> 'tokenId'
FROM "audit_log" AS a
WHERE a."event_type" = 'proposal_created'
  AND a."metadata" ->> 'proposalId' = p."id"
  AND p."origin" = 'agent' AND p."type" IN ('create', 'update')
  AND p."token_id" IS NULL
  AND EXISTS (SELECT 1 FROM "project_tokens" t WHERE t."id" = a."metadata" ->> 'tokenId');
