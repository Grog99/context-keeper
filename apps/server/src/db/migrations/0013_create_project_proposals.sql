-- Roadmap v1.5, scope B: propozycja `create_project` (założenie projektu przez agenta z tokenem konta).
-- UWAGA (55P04): drizzle stosuje wszystkie oczekujące migracje w JEDNEJ transakcji, a Postgres
-- zabrania użycia nowej wartości enuma w transakcji, która ją dodała. Dlatego predykat indeksu NIE
-- odwołuje się do `type = 'create_project'` — przeszedłby na świeżej bazie (enum tworzony w tej samej
-- transakcji), a wywaliłby upgrade z 0012. Niezmiennik: tylko payload `create_project` ma klucz
-- `slug` na najwyższym poziomie. Chroni to test `proposals-create-project.migration.spec.ts`.
-- Nieodwracalna: Postgres nie ma `DROP VALUE` dla enuma.
ALTER TYPE "public"."proposal_type" ADD VALUE 'create_project';--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_create_project_slug_pending_key" ON "proposals" USING btree (("payload" ->> 'slug')) WHERE "proposals"."status" = 'pending' AND ("proposals"."payload" ->> 'slug') IS NOT NULL;
