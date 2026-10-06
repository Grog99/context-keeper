-- Roadmap v1.6, „Nocny job na skali" (ticket nightly-scale, dług #5 i #7): dwa indeksy.
-- (1) `proposals_status_created_id_idx (status, created_at, id)` — keyset listy kolejki
--     (`WHERE status = … ORDER BY created_at, id LIMIT n`) bez sortowania; `proposals_status_idx` zostaje.
-- (2) `audit_affected_ids_idx` (GIN, `array_ops`) — filtr projektu w Audycie
--     (`affected_ids && ARRAY(SELECT id FROM memories WHERE project_id = …)`) przestaje być skanem sekwencyjnym.
-- UWAGA: zwykły `CREATE INDEX`, NIE `CONCURRENTLY` — migrator drizzle owija wszystkie oczekujące migracje w
-- JEDNĄ transakcję, a `CONCURRENTLY` w transakcji nie działa. Konsekwencja: na czas budowy indeksu tabela
-- jest zablokowana na ZAPIS (`audit_log` — a każdy zapis do pamięci pisze audyt). Na instancji jednego
-- operatora to sekundy; deploy idzie automatycznie po merge'u, więc sprawdź rozmiar `audit_log` wcześniej.
-- `fastupdate = off` na GIN: wpisy idą od razu do drzewa, bez pending list — koszt indeksu w planerze nie
-- zależy od chwilowej długości kolejki (stabilny plan filtra projektu); wolumen zapisów audytu jest mały.
-- Odwracalna: `DROP INDEX` obu.
CREATE INDEX "proposals_status_created_id_idx" ON "proposals" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_affected_ids_idx" ON "audit_log" USING gin ("affected_ids") WITH (fastupdate=false);