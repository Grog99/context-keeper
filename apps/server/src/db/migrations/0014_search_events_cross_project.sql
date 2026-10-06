-- Roadmap v1.5, wyszukiwanie między projektami (G9): flaga `cross_project` na `search_events` — wyszukiwanie
-- z `all_projects: true` zapisuje się pod bieżącym projektem i tokenem, ale z flagą, żeby ekran „Pomiary"
-- mógł je wyłączyć z zero-result rate i pokazać udział trybu cross. DEFAULT false — istniejące wiersze to
-- zwykłe wyszukiwania (informacji nie da się odtworzyć wstecz, więc flaga jest wiernie false).
ALTER TABLE "search_events" ADD COLUMN "cross_project" boolean DEFAULT false NOT NULL;
