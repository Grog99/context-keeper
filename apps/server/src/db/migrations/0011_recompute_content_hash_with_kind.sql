-- Custom SQL migration file, put your code below! --

-- Roadmap v1.3 "Dedup kind-aware": `computeContentHash` teraz niesie `kind` jako piąte pole
-- materiału (patrz `apps/server/src/common/content-hash.ts`). Przeliczamy WSZYSTKIE istniejące
-- `proposals.content_hash` (nie tylko `status='pending'`) na nową formułę, żeby przyszłe zapytania
-- dedup wobec starych pending proposali dalej działały poprawnie — `memories` nie ma własnej
-- kolumny hash, więc to jedyne miejsce, gdzie starą formułę trzeba domigrować.
--
-- `chr(31)` (nie literalny bajt 0x1F) — niewidoczny w code review, narażony na normalizację przez
-- edytor/`.gitattributes`. `||` konkatenacja (nie `concat_ws`, który cicho pomija NULL-e i przesuwa
-- granice pól) — dowolny NULL w łańcuchu `||` daje NULL, a `WHERE` niżej gwarantuje, że taki wiersz
-- nigdy nie zostanie zapisany (zostaje przy starym hashu zamiast dostać błędny).
UPDATE "proposals"
SET "content_hash" = encode(
  sha256(convert_to(
    (payload->>'header') || chr(31) ||
    (payload->>'body')   || chr(31) ||
    "scope"::text        || chr(31) ||
    coalesce("project_id", '') || chr(31) ||
    (payload->>'kind'),
    'UTF8'
  )),
  'hex'
)
WHERE "content_hash" IS NOT NULL
  AND payload->>'header' IS NOT NULL
  AND payload->>'body'   IS NOT NULL
  AND payload->>'kind'   IS NOT NULL;
