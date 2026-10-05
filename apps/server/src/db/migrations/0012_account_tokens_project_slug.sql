-- Operacyjnie nieodwracalna po utworzeniu pierwszego tokenu konta: powrót do `project_id NOT NULL` wymagałby usunięcia tokenów konta.
ALTER TABLE "project_tokens" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
-- Kolumna `slug` najpierw NULLABLE: generowane przez drizzle-kit `ADD COLUMN ... NOT NULL` wywaliłoby
-- migrację na niepustej tabeli `projects`. Kolejność jest load-bearing (precedens: 0010): dodaj
-- nullable -> backfill -> SET NOT NULL -> dopiero potem unikalny indeks i CHECK. Stan końcowy jest
-- identyczny ze snapshotem (meta/0012_snapshot.json), zmieniona jest wyłącznie kolejność kroków.
ALTER TABLE "projects" ADD COLUMN "slug" text;--> statement-breakpoint
-- Backfill slugów (roadmap v1.5, ticket #16). Reguły MUSZĄ być identyczne z `projects/slug.ts`
-- (`slugifyProjectName` / `fallbackSlug` / `withCollisionSuffix`) — parytet pilnuje test
-- `project-slug.migration.spec.ts` na wspólnej tabeli przypadków:
--   1. transliteracja (polskie + popularne łacińskie diakrytyki; `translate` PRZED `lower()`, więc
--      wielkie litery obsługuje tabela, a nie locale bazy),
--   2. lowercase, ciągi znaków spoza [a-z0-9] -> jeden '-', trim '-', cięcie do 48, trim końcowego '-',
--   3. wynik krótszy niż 2 znaki -> 'project-<końcówka id>' (bez prefiksu 'proj_', tylko [a-z0-9]),
--   4. kolizja -> sufiks '-2', '-3', ... (baza obcinana tak, by całość mieściła się w 48 znakach);
--      kolejność deterministyczna: ORDER BY created_at, id (starszy projekt dostaje „czysty" slug).
DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n int;
BEGIN
  FOR r IN SELECT id, name FROM projects ORDER BY created_at, id LOOP
    base := lower(translate(r.name, 'ąáàâäãåćčçďęéèêëěíìîïłľĺńňñóôöõőřŕśšťúùûüůűýÿźżžĄÁÀÂÄÃÅĆČÇĎĘÉÈÊËĚÍÌÎÏŁĽĹŃŇÑÓÔÖÕŐŘŔŚŠŤÚÙÛÜŮŰÝŸŹŻŽ', 'aaaaaaacccdeeeeeeiiiilllnnnooooorrsstuuuuuuyyzzzAAAAAAACCCDEEEEEEIIIILLLNNNOOOOORRSSTUUUUUUYYZZZ'));
    base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
    base := trim(both '-' from base);
    base := trim(trailing '-' from left(base, 48));
    IF char_length(base) < 2 THEN
      base := 'project-' || regexp_replace(lower(regexp_replace(r.id, '^proj_', '')), '[^a-z0-9]', '', 'g');
      base := trim(trailing '-' from left(base, 48)); -- puste "końcówka" -> samo 'project'
    END IF;
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM projects WHERE slug = candidate) LOOP
      n := n + 1;
      candidate := trim(trailing '-' from left(base, 48 - char_length('-' || n::text))) || '-' || n::text;
    END LOOP;
    UPDATE projects SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_key" ON "projects" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_slug_format_check" CHECK ("projects"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("projects"."slug") BETWEEN 2 AND 48);--> statement-breakpoint
CREATE UNIQUE INDEX "project_tokens_account_label_active_key" ON "project_tokens" USING btree ("label") WHERE "project_tokens"."project_id" IS NULL AND "project_tokens"."status" = 'active';
