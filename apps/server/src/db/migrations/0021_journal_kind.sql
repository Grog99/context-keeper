-- Roadmap v1.8, ticket `journal-kind`: nowa wartość enuma `memory_kind` — `journal` (wpis dziennika agenta).
-- UWAGA (55P04): drizzle stosuje wszystkie oczekujące migracje w JEDNEJ transakcji, a Postgres zabrania użycia
-- nowej wartości enuma w transakcji, która ją dodała. Dlatego ta migracja NIE używa `'journal'` (żaden INSERT,
-- indeks częściowy ani CHECK) — pierwszy wiersz `journal` powstaje dopiero w aplikacji, po commicie migracji.
-- Nieodwracalna: Postgres nie ma `DROP VALUE` dla enuma.
-- Chroni ją `journal-kind.migration.spec.ts` (upgrade 0020 -> 0021 na niepustej bazie).
ALTER TYPE "public"."memory_kind" ADD VALUE 'journal';
