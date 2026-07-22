#!/bin/sh
# infra/restore.sh — odtwarza dump (ck-*.dump, pg_dump -Fc) do DEDYKOWANEJ bazy scratch.
# NIGDY nie dotyka bazy produkcyjnej (POSTGRES_DB) — promocja do prod to osobny, udokumentowany
# krok MANUALNY (patrz README "Backup / Restore" -> runbook restore). Faza 7 (NFR-5) — plan §2.
#
# Użycie:
#   infra/restore.sh <dump-file> [target-db] [--force]
#     <dump-file>  ścieżka do pliku ck-*.dump (wymagane)
#     [target-db]  nazwa bazy docelowej (domyślnie: context_keeper_restore)
#     --force      jeśli target-db już istnieje, usuń ją (dropdb) i utwórz od nowa
#
# POSIX sh — patrz backup.sh nagłówek re: dash/pipefail (ta sama uwaga dotyczy tego pliku, choć
# nie ma tu żadnego pipe'a).
set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
cd -- "$SCRIPT_DIR/.."   # repo root — tu leży docker-compose.yml + .env

# --- .env (opcjonalne) ---
# CELOWO NIE source'owane przez `sh` (patrz backup.sh dla pełnego uzasadnienia: .env zawiera
# nieucytowane wartości jak `NIGHTLY_CRON=0 3 * * *`, które rozwalają `sh` przy source'owaniu).
# Parsujemy ręcznie, linia-po-linii, TYLKO znane klucze.
if [ -f .env ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in ''|'#'*) continue ;; esac
    _v=${_v%$(printf '\r')}   # CRLF guard (.env bywa edytowany na Windows-dev)
    case "$_k" in
      POSTGRES_USER) POSTGRES_USER=$_v ;;
      POSTGRES_DB) POSTGRES_DB=$_v ;;
    esac
  done < .env
fi

POSTGRES_USER=${POSTGRES_USER:-ck}
POSTGRES_DB=${POSTGRES_DB:-context_keeper}
DEFAULT_TARGET="context_keeper_restore"

DUMP=""
TARGET="$DEFAULT_TARGET"
FORCE=""
target_given=""

for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=1
      ;;
    *)
      if [ -z "$DUMP" ]; then
        DUMP=$arg
      elif [ -z "$target_given" ]; then
        TARGET=$arg
        target_given=1
      else
        echo "[restore] BŁĄD: zbyt wiele argumentów pozycyjnych" >&2
        exit 1
      fi
      ;;
  esac
done

if [ -z "$DUMP" ]; then
  echo "Użycie: infra/restore.sh <dump-file> [target-db] [--force]" >&2
  echo "  target-db domyślnie: ${DEFAULT_TARGET} (scratch — nigdy baza produkcyjna)" >&2
  exit 1
fi
if [ ! -f "$DUMP" ]; then
  echo "[restore] BŁĄD: nie znaleziono pliku dumpa: $DUMP" >&2
  exit 1
fi

# Bezpiecznik: restore.sh NIGDY nie celuje w bazę produkcyjną (POSTGRES_DB) — nawet gdyby ktoś
# jawnie podał tę samą nazwę jako target-db. Promocja do prod jest osobnym, manualnym krokiem
# (README) — celowo NIE jest flagą tego skryptu: zbyt łatwo nadpisać prod przez pomyłkę w
# komendzie odpalanej pod cronem albo ręcznie w pośpiechu podczas incydentu.
if [ "$TARGET" = "$POSTGRES_DB" ]; then
  echo "[restore] BŁĄD: target-db ('$TARGET') == POSTGRES_DB (baza produkcyjna) — restore.sh" >&2
  echo "  tego odmawia. Odtwórz do bazy scratch, zweryfikuj, potem promuj RĘCZNIE (patrz README)." >&2
  exit 1
fi

echo "[restore] target=$TARGET dump=$DUMP user=$POSTGRES_USER"

exists=$(docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '${TARGET}'")
if [ "$exists" = "1" ]; then
  if [ -n "$FORCE" ]; then
    echo "[restore] --force: usuwam istniejącą bazę '$TARGET'"
    docker compose exec -T db dropdb -U "$POSTGRES_USER" -- "$TARGET"
  else
    echo "[restore] BŁĄD: baza '$TARGET' już istnieje — użyj --force, żeby ją nadpisać" >&2
    exit 1
  fi
fi

echo "[restore] createdb $TARGET"
docker compose exec -T db createdb -U "$POSTGRES_USER" -- "$TARGET"

echo "[restore] pg_restore -> $TARGET (schema + dane; CREATE EXTENSION vector + HNSW z DDL dumpa)"
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$TARGET" < "$DUMP"

echo "[restore] sanity check..."
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$TARGET" -c "
  SELECT
    (SELECT count(*) FROM memories)   AS memories,
    (SELECT count(*) FROM embeddings) AS embeddings,
    (SELECT count(*) FROM projects)   AS projects;
"
# Trywialne query wektorowe — dowód, że rozszerzenie `vector` i dane wektorowe naprawdę się
# odtworzyły (nie tylko schema): dystans kosinusowy wektora względem samego siebie ~= 0.
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$TARGET" -c "
  SELECT id, vector <=> vector AS self_distance
  FROM embeddings
  LIMIT 1;
"

cat <<EOF

[restore] gotowe. Baza '$TARGET' zawiera odtworzone dane — ZWERYFIKUJ wyniki wypisane wyżej
(rows w memories/embeddings/projects zgodne z oczekiwaniem, self_distance ~0).

Promocja do produkcji ('$TARGET' -> '$POSTGRES_DB') — RĘCZNA, poza zakresem tego skryptu:
  1. docker compose stop app
  2. infra/backup.sh                              # backup bieżącej prod, jeśli jeszcze żyje
  3. docker compose exec -T db psql -U $POSTGRES_USER -d postgres -c "ALTER DATABASE $POSTGRES_DB RENAME TO ${POSTGRES_DB}_old;"
  4. docker compose exec -T db psql -U $POSTGRES_USER -d postgres -c "ALTER DATABASE $TARGET RENAME TO $POSTGRES_DB;"
  5. docker compose up -d app
  6. curl localhost:3000/health                   # potwierdź {"status":"ok","db":"up"}
  7. Po weryfikacji: docker compose exec -T db dropdb -U $POSTGRES_USER -- ${POSTGRES_DB}_old
EOF
