-- Roadmap v1.6, A1 „Detekcja prawie-duplikatów przy zapisie": kolumna `proposals.similar_memories` —
-- wynik podpowiedzi „podobne do istniejących" liczony raz przy save_memory (agent, create, fact/document).
-- Trzy stany: NULL = nie policzono, `[]` = policzono, brak podobnych, lista `{id, distance}` (≤3, rosnąco).
-- Istniejące wiersze zostają NULL (bez backfillu — dotyczy tylko nowych zapisów). Nullable ADD COLUMN bez
-- DEFAULT to zmiana wyłącznie metadanych (bez przepisywania tabeli, krótki lock).
-- Odwracalna: `ALTER TABLE "proposals" DROP COLUMN "similar_memories"`.
ALTER TABLE "proposals" ADD COLUMN "similar_memories" jsonb;
