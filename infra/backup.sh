#!/bin/sh
# infra/backup.sh — pg_dump (custom format, -Fc) do BACKUP_DIR + retencja tiered (7 daily +
# 4 weekly, patrz prune_backups niżej) + opcjonalny offsite hook. Faza 7 (NFR-5) — plan §1a/§2.
# Każdy przebieg (sukces LUB porażka) loguje też do audit_log (event `backup_completed`, przez
# CLI `record-backup` w kontenerze `app`) — best-effort: fail zapisu audytu NIE zmienia exit code
# skryptu (ani w jedną, ani w drugą stronę, patrz komentarze przy poszczególnych wywołaniach niżej).
#
# Uruchamia pg_dump WEWNĄTRZ kontenera `db` (docker compose exec) — gwarantuje zgodność wersji
# klienta z serwerem (pgvector/pgvector:pg18-trixie); obraz `app` nie ma pg_dump wcale.
#
# POSIX sh (dash na docelowym Debianie — patrz context/tech-stack.md §9 dla install.sh) — bez
# bashizmów. UWAGA: `set -o pipefail` to bashizm, dash go nie wspiera — świadomie POMINIĘTY.
# Jedyny pipe w tym pliku (prune_backups: for|sort|awk|while) nie ma etapu, którego cichy fail
# mógłby przeoczyć coś, czego już nie łapie `|| continue` per-plik w pętli for.
set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
cd -- "$SCRIPT_DIR/.."   # repo root — tu leży docker-compose.yml + .env

# --- .env (opcjonalne) ---
# CELOWO NIE source'owane przez `sh` (`. ./.env`): plik .env to format dotenv/Node
# `loadEnvFile` (permisywny), NIE POSIX shell syntax. Realne wartości w .env.example, np.
# `NIGHTLY_CRON=0 3 * * *` (spacje + gwiazdka bez cudzysłowu), rozwalają `sh` przy source'owaniu
# (nieucytowana gwiazdka+spacje = osobne tokeny/glob, "3" traktowane jako komenda do wykonania —
# zweryfikowane empirycznie: `set -e` ubija skrypt na pierwszej takiej linii). Parsujemy więc
# ręcznie, linia-po-linii, TYLKO znane klucze, bez `eval` i bez wykonywania zawartości pliku.
if [ -f .env ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in ''|'#'*) continue ;; esac
    _v=${_v%$(printf '\r')}   # CRLF guard (.env bywa edytowany na Windows-dev)
    case "$_k" in
      POSTGRES_USER) POSTGRES_USER=$_v ;;
      POSTGRES_DB) POSTGRES_DB=$_v ;;
      BACKUP_DIR) BACKUP_DIR=$_v ;;
      BACKUP_RETENTION_DAILY_DAYS) BACKUP_RETENTION_DAILY_DAYS=$_v ;;
      BACKUP_RETENTION_WEEKLY_WEEKS) BACKUP_RETENTION_WEEKLY_WEEKS=$_v ;;
      BACKUP_OFFSITE_CMD) BACKUP_OFFSITE_CMD=$_v ;;
      RCLONE_REMOTE) RCLONE_REMOTE=$_v ;;
    esac
  done < .env
fi

POSTGRES_USER=${POSTGRES_USER:-ck}
POSTGRES_DB=${POSTGRES_DB:-context_keeper}
BACKUP_DIR=${BACKUP_DIR:-./backups}
BACKUP_RETENTION_DAILY_DAYS=${BACKUP_RETENTION_DAILY_DAYS:-7}
BACKUP_RETENTION_WEEKLY_WEEKS=${BACKUP_RETENTION_WEEKLY_WEEKS:-4}
BACKUP_OFFSITE_CMD=${BACKUP_OFFSITE_CMD:-}
RCLONE_REMOTE=${RCLONE_REMOTE:-}

umask 077   # dumpy są wrażliwe (memories.body może zawierać treść human-authored bez skanu sekretów)
mkdir -p -- "$BACKUP_DIR"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$BACKUP_DIR/ck-${stamp}.dump"
tmp="$BACKUP_DIR/.ck-${stamp}.dump.tmp"

# Sprząta partial temp przy dowolnym wyjściu (błąd/Ctrl-C) — po udanym `mv` plik tmp już nie
# istnieje, więc `rm -f` w cleanup jest wtedy no-opem.
cleanup() {
  rm -f -- "$tmp"
}
trap cleanup EXIT INT TERM

echo "[backup] dumping ${POSTGRES_DB} (user=${POSTGRES_USER}) przez docker compose exec db pg_dump ..."
if ! docker compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$tmp"; then
  echo "[backup] BŁĄD: pg_dump nie powiódł się — patrz output wyżej" >&2
  # Audit best-effort: jeśli record-backup sam zawiedzie (np. `app`/`db` niedostępne), nie maskujemy
  # oryginalnego exit 1 poniżej — to on jest sygnałem prawdy dla crona/monitoringu.
  docker compose run --rm app node dist/cli.js record-backup --status=failed --error="pg_dump failed" \
    || echo "[backup] UWAGA: zapis audytu record-backup nie powiodł się" >&2
  exit 1
fi
if [ ! -s "$tmp" ]; then
  echo "[backup] BŁĄD: dump jest pusty" >&2
  docker compose run --rm app node dist/cli.js record-backup --status=failed --error="empty dump" \
    || echo "[backup] UWAGA: zapis audytu record-backup nie powiodł się" >&2
  exit 1
fi

# Atomowy mv (temp-then-mv) zamiast pisania bezpośrednio do nazwy docelowej — żaden reader nigdy
# nie widzi pliku z nazwą "ck-*.dump", który jest jeszcze w trakcie zapisu/obcięty przy failure.
mv -- "$tmp" "$final"
chmod 600 -- "$final"
size=$(wc -c < "$final" | tr -d ' ')
echo "[backup] dump OK: ${final} (${size} bajtów, mode 600)"

# --- Retencja tiered (7 daily + 4 weekly) — pełny projekt algorytmu w planie Fazy 7 §1a ---
# Wywoływana TYLKO po potwierdzonym sukcesie nowego dumpa (wyżej). Klucz wieku/tygodnia z NAZWY
# pliku (UTC ISO stamp w nazwie), NIE z mtime — mtime resetuje cp/rclone round-trip/restore/touch.
# Zależność: GNU coreutils `date` (cel wdrożenia Linux VPS; BSD `date -j` świadomie nieobsługiwany).
prune_backups() {
  now=$(date -u +%s)
  dd=${BACKUP_RETENTION_DAILY_DAYS}     # np. 7
  ww=${BACKUP_RETENTION_WEEKLY_WEEKS}   # np. 4  (0 = wyłącz weekly tier -> retencja płaska dd dni)
  tab=$(printf '\t')                    # dash nie ma $'\t' — literalny tab przez printf

  for f in "$BACKUP_DIR"/ck-*.dump; do
    [ -e "$f" ] || continue                       # guard: glob bez dopasowania
    b=${f##*/}; s=${b#ck-}; stamp=${s%.dump}       # YYYYMMDDThhmmssZ
    d=${stamp%T*}                                  # YYYYMMDD
    iso=$(printf '%s' "$d" | sed 's/^\(....\)\(..\)\(..\)$/\1-\2-\3/')  # YYYY-MM-DD
    ep=$(date -u -d "$iso" +%s) || continue        # nieparsowalna nazwa -> pomiń (nie kasuj)
    wk=$(date -u -d "$iso" +%G-%V)                 # ISO rok-tydzień (NIE %Y — granica roku)
    printf '%s\t%s\t%s\t%s\n' "$stamp" "$ep" "$wk" "$f"
  done | LC_ALL=C sort -t "$tab" -k1,1 | awk -F'\t' -v now="$now" -v dd="$dd" -v ww="$ww" '
    { ep=$2; wk=$3; path=$4; age=int((now-ep)/86400)
      a[NR]=age; w[NR]=wk; p[NR]=path
      if (age >= dd && age < dd + ww*7) rep[wk]=NR }  # rosnąco => OSTATNI widziany = najnowszy
    END { for (i=1; i<=NR; i++) {
            if (a[i] < dd) continue                       # daily tier: zachowaj
            if (a[i] < dd + ww*7 && rep[w[i]] == i) continue  # reprezentant tygodnia: zachowaj
            print p[i] } }                                 # reszta: kasuj
  ' | while IFS= read -r victim; do
        rm -f -- "$victim"
        printf '[backup] retention: removed %s\n' "${victim##*/}"
     done
}
prune_backups

# --- Offsite (opcjonalny pluggable hook) — BACKUP_OFFSITE_CMD ma pierwszeństwo nad RCLONE_REMOTE ---
# Fail offsite = głośny exit 1 pod cronem/monitoringiem; lokalny dump ZOSTAJE (nie jest kasowany).
offsite="skipped"
if [ -n "$BACKUP_OFFSITE_CMD" ]; then
  echo "[backup] offsite: BACKUP_OFFSITE_CMD (\$1 = ${final})"
  if sh -c "$BACKUP_OFFSITE_CMD" sh "$final"; then
    offsite="custom"
  else
    echo "[backup] BŁĄD: BACKUP_OFFSITE_CMD nie powiódł się — lokalny dump ZOSTAJE (${final})" >&2
    docker compose run --rm app node dist/cli.js record-backup --status=failed --dump="$final" --size="$size" \
      --error="offsite BACKUP_OFFSITE_CMD failed" \
      || echo "[backup] UWAGA: zapis audytu record-backup nie powiodł się" >&2
    exit 1
  fi
elif [ -n "$RCLONE_REMOTE" ]; then
  echo "[backup] offsite: rclone copy -> ${RCLONE_REMOTE}"
  if rclone copy -- "$final" "$RCLONE_REMOTE"; then
    offsite="rclone:${RCLONE_REMOTE}"
  else
    echo "[backup] BŁĄD: rclone copy nie powiódł się — lokalny dump ZOSTAJE (${final})" >&2
    docker compose run --rm app node dist/cli.js record-backup --status=failed --dump="$final" --size="$size" \
      --error="offsite rclone failed" \
      || echo "[backup] UWAGA: zapis audytu record-backup nie powiodł się" >&2
    exit 1
  fi
else
  echo "[backup] offsite: pominięty (brak BACKUP_OFFSITE_CMD / RCLONE_REMOTE)"
fi

echo "[backup] status=ok dump=${final} size=${size} offsite=${offsite}"
# Audit best-effort: backup SAM w sobie już się udał (dump + offsite wyżej) — jeśli tylko zapis do
# audit_log zawiedzie, NIE robimy z tego exit 1 (fałszywy alarm "backup failed" pod monitoringiem
# byłby gorszy niż brak jednego wpisu w audycie).
docker compose run --rm app node dist/cli.js record-backup --status=ok --dump="$final" --size="$size" --offsite="$offsite" \
  || echo "[backup] UWAGA: zapis audytu record-backup nie powiodł się (dump sam jest OK)" >&2
