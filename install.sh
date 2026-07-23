#!/bin/sh
# install.sh — Context Keeper onboarding installer (roadmap item 8, "Onboarding / instalator").
#
# Thin generator over `.env` + Compose profiles — NOT a config layer of its own. The canon of
# config is the versioned `.env.example` (full, commented variable list); this script templates
# it line-by-line, it never duplicates or replaces it. Two phases:
#   Phase 1 (always runs, fully offline) — collect answers, write/preview `.env`.
#   Phase 2 (optional, prompted; default = generation only) — `docker compose up`, migrations,
#            first project + bearer token (delegated entirely to the Nest CLI).
#
# POSIX sh (dash on the target Debian host) — no bashisms: no `local`, no `[[ ]]`, no `echo -e`,
# no `pipefail`, no arrays, no `${var,,}`. Style mirrors `infra/backup.sh`: `set -eu`, `--` before
# path arguments, `printf` instead of `echo -e`, umask 077 before writing secrets, atomic
# temp-file-then-`mv` write, one-line status summary at the end.
#
# All prompts/messages/comments/help/output in this script are ENGLISH (deliberate choice, even
# though the rest of the repo/CLI is Polish — wider reach for operators running this on a bare VPS).
set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
cd -- "$SCRIPT_DIR"

if [ ! -f .env.example ]; then
  printf 'error: .env.example not found in %s (run this script from the repo root)\n' "$SCRIPT_DIR" >&2
  exit 1
fi

# Dev placeholders from .env.example — secrets are ONLY (re)generated when the captured value is
# empty or matches one of these known dev defaults. A re-run must never silently invalidate an
# existing session by regenerating SESSION_SECRET.
DEV_SESSION_SECRET_PLACEHOLDER='dev-session-secret-change-me'
DEV_DASHBOARD_PASSWORD_PLACEHOLDER='changeme-dev'

# ------------------------------------------------------------------------------------------------
# Cleanup: always trap so a partial temp `.env` never survives a failed/interrupted run. Mirrors
# infra/backup.sh's cleanup() pattern — after a successful `mv` the file is already gone, so `rm -f`
# here is simply a no-op.
# ------------------------------------------------------------------------------------------------
TMP_ENV=''
cleanup() {
  if [ -n "$TMP_ENV" ] && [ -f "$TMP_ENV" ]; then
    rm -f -- "$TMP_ENV"
  fi
}
trap cleanup EXIT INT TERM

usage() {
  cat <<'EOF'
Usage: ./install.sh [OPTIONS]

Context Keeper onboarding installer.

  Phase 1 (always runs, offline) generates ./.env from .env.example: it asks a few questions
  (edge/proxy mode, embedding preset, nightly job schedule, first project name), preserves or
  generates SESSION_SECRET/DASHBOARD_PASSWORD safely, and writes the result atomically
  (mode 600). It never duplicates .env.example — untouched keys/comments pass through verbatim.

  Phase 2 (optional, prompted; default = generation only) can start the Docker Compose stack,
  run migrations, and mint the first project's bearer token via the Nest CLI (token is printed
  once by the CLI itself — this script never mints or stores it).

Options:
  -y, --yes      Accept all defaults, no interactive prompts. If ./.env already exists, this is
                 the explicit confirmation to regenerate/overwrite it (secrets are still only
                 (re)generated when missing or a known dev placeholder — see above).
      --start    Force Phase 2 to start the stack (skips the "start now?" prompt).
      --no-start Force Phase 2 to skip starting the stack (skips the "start now?" prompt).
      --dry-run  Print the .env that would be written to stdout; write NOTHING to disk and run no
                 Docker commands. SESSION_SECRET/DASHBOARD_PASSWORD are NEVER printed, even in
                 --dry-run — see the comment above emit_env() below for why and how.
  -h, --help     Show this help and exit.

Examples:
  ./install.sh                   Fully interactive.
  ./install.sh --dry-run --yes   Preview the default .env; nothing is written or executed.
  ./install.sh --yes --no-start  Generate .env with defaults, skip starting Docker.
EOF
}

# ---------------------------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------------------------
YES=0
DRY_RUN=0
START_MODE=ask   # ask|yes|no

for _arg in "$@"; do
  case "$_arg" in
    -y|--yes) YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --start) START_MODE=yes ;;
    --no-start) START_MODE=no ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'error: unknown option: %s\n\n' "$_arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$DRY_RUN" -eq 1 ] && [ "$START_MODE" != "ask" ]; then
  printf '[install] NOTE: --dry-run makes no changes and runs no Docker commands — --start/--no-start is ignored.\n' >&2
fi

# ---------------------------------------------------------------------------------------------
# Helpers: ask (free text), ask_choice (constrained single-token choice), confirm (yes/no).
# None of these use `eval`/indirect assignment — callers read the result back from $ANSWER (or
# the function's own exit status for confirm), then assign it to a named variable themselves.
# ---------------------------------------------------------------------------------------------
ANSWER=''

ask() {
  # $1 = question, $2 = default (may be empty). Result in $ANSWER. Under --yes, returns the
  # default without touching stdin (so --dry-run --yes never blocks on a closed/non-tty stdin).
  _ask_q=$1
  _ask_def=$2
  if [ "$YES" -eq 1 ]; then
    ANSWER=$_ask_def
    return 0
  fi
  if [ -n "$_ask_def" ]; then
    printf '%s [%s]: ' "$_ask_q" "$_ask_def" >&2
  else
    printf '%s: ' "$_ask_q" >&2
  fi
  IFS= read -r ANSWER || ANSWER=''
  if [ -z "$ANSWER" ]; then
    ANSWER=$_ask_def
  fi
}

ask_choice() {
  # $1 = question, $2 = default token, $3 = space-separated allowed tokens (uppercase).
  # Loops until a valid token is given (case-insensitive). Result in $ANSWER (uppercase).
  _qc_q=$1
  _qc_def=$2
  _qc_allowed=$3
  if [ "$YES" -eq 1 ]; then
    ANSWER=$_qc_def
    return 0
  fi
  while :; do
    printf '%s [%s]: ' "$_qc_q" "$_qc_def" >&2
    IFS= read -r _qc_raw || _qc_raw=''
    if [ -z "$_qc_raw" ]; then
      _qc_raw=$_qc_def
    fi
    _qc_up=$(printf '%s' "$_qc_raw" | tr '[:lower:]' '[:upper:]')
    for _qc_opt in $_qc_allowed; do
      if [ "$_qc_up" = "$_qc_opt" ]; then
        ANSWER=$_qc_up
        return 0
      fi
    done
    printf '  please answer one of: %s\n' "$_qc_allowed" >&2
  done
}

confirm() {
  # $1 = question, $2 = default "y" or "n". Returns 0 for yes, 1 for no (never touches $ANSWER).
  _cf_q=$1
  _cf_def=$2
  if [ "$YES" -eq 1 ]; then
    if [ "$_cf_def" = "y" ]; then
      return 0
    fi
    return 1
  fi
  if [ "$_cf_def" = "y" ]; then
    _cf_suffix='[Y/n]'
  else
    _cf_suffix='[y/N]'
  fi
  printf '%s %s: ' "$_cf_q" "$_cf_suffix" >&2
  IFS= read -r _cf_ans || _cf_ans=''
  if [ -z "$_cf_ans" ]; then
    _cf_ans=$_cf_def
  fi
  case "$_cf_ans" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

profiles_to_mode() {
  # $1 = comma-separated COMPOSE_PROFILES; echoes "A" (edge-proxy present) or "B" (absent).
  case ",$1," in
    *,edge-proxy,*) printf 'A\n' ;;
    *) printf 'B\n' ;;
  esac
}

set_embedding_trio() {
  # $1 = preset name; sets OUT_EMBEDDING_PROVIDER/MODEL/DIM to match env.ts's
  # EMBEDDING_PRESET_TRIO exactly (installer choices must match the authoritative mapping there).
  case "$1" in
    multilingual)
      OUT_EMBEDDING_PROVIDER=local
      OUT_EMBEDDING_MODEL=bge-m3
      OUT_EMBEDDING_DIM=1024
      ;;
    english)
      OUT_EMBEDDING_PROVIDER=local
      OUT_EMBEDDING_MODEL=bge-small-en-v1.5
      OUT_EMBEDDING_DIM=384
      ;;
    api)
      OUT_EMBEDDING_PROVIDER=api
      OUT_EMBEDDING_MODEL=text-embedding-3-small
      OUT_EMBEDDING_DIM=1536
      ;;
    *)
      printf 'internal error: unknown embedding preset "%s"\n' "$1" >&2
      exit 1
      ;;
  esac
}

compute_profiles() {
  # Uses EDGE_MODE + OUT_EMBEDDING_PROVIDER (must be set first). Sets OUT_COMPOSE_PROFILES.
  _cp_profiles=''
  if [ "$OUT_EMBEDDING_PROVIDER" = "local" ]; then
    _cp_profiles='local-embeddings'
  fi
  if [ "$EDGE_MODE" = "A" ]; then
    if [ -n "$_cp_profiles" ]; then
      _cp_profiles="${_cp_profiles},edge-proxy"
    else
      _cp_profiles='edge-proxy'
    fi
  fi
  OUT_COMPOSE_PROFILES=$_cp_profiles
}

# ---------------------------------------------------------------------------------------------
# Phase 0a — parse the existing .env (if any), line-by-line, known keys only. Reused parser
# style from infra/backup.sh: no `. ./.env` (source) — `.env.example` has values like
# `NIGHTLY_CRON=0 3 * * *` that break `sh` source semantics (unquoted `*`/spaces) — so we parse
# manually, never `eval`, never execute file contents.
# ---------------------------------------------------------------------------------------------
OLD_SESSION_SECRET=''
OLD_DASHBOARD_PASSWORD=''
OLD_EMBEDDING_DIM=''
OLD_EMBEDDING_PROVIDER=''
OLD_EMBEDDING_MODEL=''
OLD_EMBEDDING_PRESET=''
OLD_EMBEDDING_API_KEY=''
OLD_EMBEDDING_API_URL=''
OLD_COMPOSE_PROFILES=''
OLD_ACME_DOMAIN=''
OLD_ACME_EMAIL=''
OLD_NIGHTLY_CRON=''
OLD_NIGHTLY_TZ=''
OLD_PORT_MCP=''

EXISTING_ENV=0
if [ -f .env ]; then
  EXISTING_ENV=1
  while IFS='=' read -r _k _v; do
    case "$_k" in ''|'#'*) continue ;; esac
    _v=${_v%"$(printf '\r')"}   # CRLF guard (.env sometimes edited on Windows)
    case "$_k" in
      SESSION_SECRET) OLD_SESSION_SECRET=$_v ;;
      DASHBOARD_PASSWORD) OLD_DASHBOARD_PASSWORD=$_v ;;
      EMBEDDING_DIM) OLD_EMBEDDING_DIM=$_v ;;
      EMBEDDING_PROVIDER) OLD_EMBEDDING_PROVIDER=$_v ;;
      EMBEDDING_MODEL) OLD_EMBEDDING_MODEL=$_v ;;
      EMBEDDING_PRESET) OLD_EMBEDDING_PRESET=$_v ;;
      EMBEDDING_API_KEY) OLD_EMBEDDING_API_KEY=$_v ;;
      EMBEDDING_API_URL) OLD_EMBEDDING_API_URL=$_v ;;
      COMPOSE_PROFILES) OLD_COMPOSE_PROFILES=$_v ;;
      ACME_DOMAIN) OLD_ACME_DOMAIN=$_v ;;
      ACME_EMAIL) OLD_ACME_EMAIL=$_v ;;
      NIGHTLY_CRON) OLD_NIGHTLY_CRON=$_v ;;
      NIGHTLY_TZ) OLD_NIGHTLY_TZ=$_v ;;
      PORT_MCP) OLD_PORT_MCP=$_v ;;
    esac
  done < .env
fi

# ---------------------------------------------------------------------------------------------
# Phase 0b — existing-.env guard (idempotence core). Never overwrite silently.
# ---------------------------------------------------------------------------------------------
ENV_ACTION=regenerate
if [ "$EXISTING_ENV" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[install] NOTE: an existing .env was found; --dry-run always previews a regenerate (as if confirmed) — it changes nothing on disk either way.\n' >&2
    ENV_ACTION=regenerate
  elif [ "$YES" -eq 1 ]; then
    printf '[install] --yes: existing .env found — regenerating (secrets kept unless empty/placeholder; see summary at the end).\n' >&2
    ENV_ACTION=regenerate
  else
    printf '\nAn existing .env was found in %s.\n' "$SCRIPT_DIR" >&2
    ask_choice 'Keep it as-is (K), regenerate it (R), or abort (A)?' 'K' 'K R A'
    case "$ANSWER" in
      K) ENV_ACTION=keep ;;
      R) ENV_ACTION=regenerate ;;
      A) ENV_ACTION=abort ;;
    esac
  fi
fi

if [ "$ENV_ACTION" = "abort" ]; then
  printf '[install] status=aborted reason=user-declined-env-change\n'
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# Phase 1 — interactive questions + templated .env write (only when regenerating).
# ---------------------------------------------------------------------------------------------
if [ "$ENV_ACTION" = "regenerate" ]; then
  EDGE_DEFAULT=A
  if [ -n "$OLD_COMPOSE_PROFILES" ]; then
    EDGE_DEFAULT=$(profiles_to_mode "$OLD_COMPOSE_PROFILES")
  fi
  printf '\n1) Edge / reverse-proxy mode:\n' >&2
  printf '   A = bundled Caddy (automatic HTTPS via Let'"'"'s Encrypt) — batteries-included for a bare VPS.\n' >&2
  printf '   B = bring-your-own-proxy (existing Traefik/nginx/Caddy/Cloudflare Tunnel, e.g. homelab).\n' >&2
  ask_choice 'Edge mode' "$EDGE_DEFAULT" 'A B'
  EDGE_MODE=$ANSWER

  if [ "$EDGE_MODE" = "A" ]; then
    OUT_TRUST_PROXY=false
    ask 'ACME domain for Let'"'"'s Encrypt (leave empty for a local HTTP-only fallback on :80)' "$OLD_ACME_DOMAIN"
    OUT_ACME_DOMAIN=$ANSWER
    case "$OUT_ACME_DOMAIN" in
      '') : ;;
      *' '*|*'http://'*|*'https://'*)
        printf '[install] WARNING: "%s" does not look like a bare hostname (no spaces/protocol expected) — only a syntactic check, continuing anyway.\n' "$OUT_ACME_DOMAIN" >&2
        ;;
    esac
    if [ -n "$OUT_ACME_DOMAIN" ]; then
      ask 'ACME email for Let'"'"'s Encrypt' "$OLD_ACME_EMAIL"
      OUT_ACME_EMAIL=$ANSWER
    else
      OUT_ACME_EMAIL=''
    fi
  else
    OUT_TRUST_PROXY=true
    OUT_ACME_DOMAIN=''
    OUT_ACME_EMAIL=''
  fi

  PRESET_DEFAULT=1
  case "$OLD_EMBEDDING_PRESET" in
    multilingual) PRESET_DEFAULT=1 ;;
    english) PRESET_DEFAULT=2 ;;
    api) PRESET_DEFAULT=3 ;;
  esac
  printf '\n2) Embedding preset:\n' >&2
  printf '   1 = multilingual (default, recommended) — local bge-m3, DIM=1024. Works end-to-end today.\n' >&2
  printf '   2 = english (lean) — local bge-small-en-v1.5, DIM=384. NOT fully wired end-to-end yet.\n' >&2
  printf '   3 = api — OpenAI-compatible text-embedding-3-small, DIM=1536. NOT fully wired end-to-end yet.\n' >&2
  ask_choice 'Embedding preset' "$PRESET_DEFAULT" '1 2 3'
  case "$ANSWER" in
    1) EMBEDDING_PRESET=multilingual ;;
    2) EMBEDDING_PRESET=english ;;
    3) EMBEDDING_PRESET=api ;;
  esac

  case "$EMBEDDING_PRESET" in
    english|api)
      printf '\n[install] WARNING: the "%s" preset is not fully wired end-to-end yet — the DB vector\n' "$EMBEDDING_PRESET" >&2
      printf '           column is a fixed vector(1024) and there is no cross-dimension migration yet\n' >&2
      printf '           (see .env.example / env.ts). Only "multilingual" (DIM=1024) works end-to-end today.\n\n' >&2
      if confirm "Proceed with the \"$EMBEDDING_PRESET\" preset anyway?" n; then
        :
      else
        printf '[install] Falling back to the "multilingual" preset.\n' >&2
        EMBEDDING_PRESET=multilingual
      fi
      ;;
  esac

  set_embedding_trio "$EMBEDDING_PRESET"

  if [ "$EMBEDDING_PRESET" = "api" ]; then
    if [ "$YES" -eq 1 ]; then
      OUT_EMBEDDING_API_KEY=$OLD_EMBEDDING_API_KEY
      EMBEDDING_API_KEY_ACTION=kept
      if [ -z "$OUT_EMBEDDING_API_KEY" ]; then
        printf '[install] WARNING: --yes with the "api" preset and no prior EMBEDDING_API_KEY leaves it EMPTY — set it manually in .env; production env validation will fail otherwise.\n' >&2
      fi
    else
      OUT_EMBEDDING_API_KEY=''
      while [ -z "$OUT_EMBEDDING_API_KEY" ]; do
        ask 'EMBEDDING_API_KEY (required for the api preset)' "$OLD_EMBEDDING_API_KEY"
        OUT_EMBEDDING_API_KEY=$ANSWER
      done
      EMBEDDING_API_KEY_ACTION=entered
    fi
    ask 'EMBEDDING_API_URL' "${OLD_EMBEDDING_API_URL:-https://api.openai.com/v1/embeddings}"
    OUT_EMBEDDING_API_URL=$ANSWER
  else
    OUT_EMBEDDING_API_KEY=''
    OUT_EMBEDDING_API_URL=''
    EMBEDDING_API_KEY_ACTION=unused
  fi

  # DIM guard: never silently overwrite EMBEDDING_DIM under existing data — warn + require
  # explicit confirmation (or, under --yes, default to the SAFE choice: keep the old trio).
  if [ "$EXISTING_ENV" -eq 1 ] && [ -n "$OLD_EMBEDDING_DIM" ] && [ "$OLD_EMBEDDING_DIM" != "$OUT_EMBEDDING_DIM" ]; then
    printf '\n[install] WARNING: existing .env has EMBEDDING_DIM=%s but the "%s" preset needs DIM=%s.\n' "$OLD_EMBEDDING_DIM" "$EMBEDDING_PRESET" "$OUT_EMBEDDING_DIM" >&2
    printf '           Changing preset/dimension under existing data is a migration (CLI: reembed),\n' >&2
    printf '           not a safe .env edit — this installer will NOT silently change EMBEDDING_DIM.\n\n' >&2
    KEEP_OLD_TRIO=1
    if [ "$YES" -eq 1 ]; then
      printf '[install] --yes: keeping the EXISTING provider/model/dim/preset from your current .env.\n' >&2
    else
      if confirm 'Apply the NEW preset anyway (only safe with no stored embeddings yet, or after running reembed)?' n; then
        KEEP_OLD_TRIO=0
      fi
    fi
    if [ "$KEEP_OLD_TRIO" -eq 1 ]; then
      EMBEDDING_PRESET=${OLD_EMBEDDING_PRESET:-custom}
      OUT_EMBEDDING_PROVIDER=$OLD_EMBEDDING_PROVIDER
      OUT_EMBEDDING_MODEL=$OLD_EMBEDDING_MODEL
      OUT_EMBEDDING_DIM=$OLD_EMBEDDING_DIM
    fi
  fi

  compute_profiles
  OUT_EMBEDDING_PRESET=$EMBEDDING_PRESET

  printf '\n3) Nightly job schedule (contract for an EXTERNAL host scheduler only — the app does not read these):\n' >&2
  ask 'NIGHTLY_CRON' "${OLD_NIGHTLY_CRON:-0 3 * * *}"
  OUT_NIGHTLY_CRON=$ANSWER
  ask 'NIGHTLY_TZ' "${OLD_NIGHTLY_TZ:-Europe/Warsaw}"
  OUT_NIGHTLY_TZ=$ANSWER

  # Installer deliberately targets deploy hosts, not local dev.
  OUT_NODE_ENV=production

  # Secrets — generate ONLY when captured value is empty or a known dev placeholder. A re-run
  # must never invalidate an existing session by silently regenerating SESSION_SECRET.
  case "$OLD_SESSION_SECRET" in
    ''|"$DEV_SESSION_SECRET_PLACEHOLDER")
      OUT_SESSION_SECRET=$(openssl rand -base64 36 | tr -d '\n')
      SESSION_SECRET_ACTION=generated
      ;;
    *)
      OUT_SESSION_SECRET=$OLD_SESSION_SECRET
      SESSION_SECRET_ACTION=kept
      ;;
  esac
  case "$OLD_DASHBOARD_PASSWORD" in
    ''|"$DEV_DASHBOARD_PASSWORD_PLACEHOLDER")
      OUT_DASHBOARD_PASSWORD=$(openssl rand -base64 36 | tr -d '\n')
      DASHBOARD_PASSWORD_ACTION=generated
      ;;
    *)
      OUT_DASHBOARD_PASSWORD=$OLD_DASHBOARD_PASSWORD
      DASHBOARD_PASSWORD_ACTION=kept
      ;;
  esac

  # -----------------------------------------------------------------------------------------
  # emit_env — templates .env.example line-by-line: managed keys get the computed value below,
  # everything else (comments, blank lines, untouched keys) passes through verbatim. This is a
  # template, never a duplication of .env.example's canon.
  #
  # DELIBERATE CHOICE for --dry-run: SESSION_SECRET/DASHBOARD_PASSWORD are ALWAYS withheld and
  # replaced with a labeled placeholder, even in --dry-run, even when the underlying value would
  # just be an already-existing secret being kept unchanged. Rationale: --dry-run output is easy
  # to paste into chat logs/CI logs/screenshots by an operator previewing the installer, and the
  # secret's actual value is never needed to verify the preview is correct (only *whether* it
  # would be generated vs kept is useful, hence the placeholder still names the action). The
  # normal (non-dry-run) path never prints .env content to stdout/logs at all — it only writes it
  # to the file. EMBEDDING_API_KEY gets the same withholding treatment whenever it is non-empty
  # (it has no value at all for the non-"api" presets, so there is nothing to withhold then).
  # -----------------------------------------------------------------------------------------
  emit_env() {
    while IFS= read -r _line || [ -n "$_line" ]; do
      case "$_line" in
        ''|'#'*) printf '%s\n' "$_line"; continue ;;
      esac
      _key=${_line%%=*}
      case "$_key" in
        NODE_ENV) printf '%s\n' "NODE_ENV=$OUT_NODE_ENV" ;;
        TRUST_PROXY) printf '%s\n' "TRUST_PROXY=$OUT_TRUST_PROXY" ;;
        EMBEDDING_PROVIDER) printf '%s\n' "EMBEDDING_PROVIDER=$OUT_EMBEDDING_PROVIDER" ;;
        EMBEDDING_MODEL) printf '%s\n' "EMBEDDING_MODEL=$OUT_EMBEDDING_MODEL" ;;
        EMBEDDING_DIM) printf '%s\n' "EMBEDDING_DIM=$OUT_EMBEDDING_DIM" ;;
        EMBEDDING_API_KEY)
          if [ "$DRY_RUN" -eq 1 ] && [ -n "$OUT_EMBEDDING_API_KEY" ]; then
            printf '%s\n' "EMBEDDING_API_KEY=<withheld in --dry-run; action=$EMBEDDING_API_KEY_ACTION>"
          else
            printf '%s\n' "EMBEDDING_API_KEY=$OUT_EMBEDDING_API_KEY"
          fi
          ;;
        EMBEDDING_PRESET) printf '%s\n' "EMBEDDING_PRESET=$OUT_EMBEDDING_PRESET" ;;
        EMBEDDING_API_URL) printf '%s\n' "EMBEDDING_API_URL=$OUT_EMBEDDING_API_URL" ;;
        NIGHTLY_CRON) printf '%s\n' "NIGHTLY_CRON=$OUT_NIGHTLY_CRON" ;;
        NIGHTLY_TZ) printf '%s\n' "NIGHTLY_TZ=$OUT_NIGHTLY_TZ" ;;
        DASHBOARD_PASSWORD)
          if [ "$DRY_RUN" -eq 1 ]; then
            printf '%s\n' "DASHBOARD_PASSWORD=<withheld in --dry-run; action=$DASHBOARD_PASSWORD_ACTION>"
          else
            printf '%s\n' "DASHBOARD_PASSWORD=$OUT_DASHBOARD_PASSWORD"
          fi
          ;;
        SESSION_SECRET)
          if [ "$DRY_RUN" -eq 1 ]; then
            printf '%s\n' "SESSION_SECRET=<withheld in --dry-run; action=$SESSION_SECRET_ACTION>"
          else
            printf '%s\n' "SESSION_SECRET=$OUT_SESSION_SECRET"
          fi
          ;;
        COMPOSE_PROFILES) printf '%s\n' "COMPOSE_PROFILES=$OUT_COMPOSE_PROFILES" ;;
        ACME_DOMAIN) printf '%s\n' "ACME_DOMAIN=$OUT_ACME_DOMAIN" ;;
        ACME_EMAIL) printf '%s\n' "ACME_EMAIL=$OUT_ACME_EMAIL" ;;
        *) printf '%s\n' "$_line" ;;
      esac
    done < .env.example
  }

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n[install] --dry-run preview of .env (SESSION_SECRET/DASHBOARD_PASSWORD/EMBEDDING_API_KEY withheld — see comment in this script) ------\n'
    emit_env
    printf '[install] --------------------------------------------------------------------------------------------------------\n'
    printf '[install] nothing written to disk.\n'
  else
    umask 077
    TMP_ENV=".env.tmp.$$"
    emit_env > "$TMP_ENV"
    mv -- "$TMP_ENV" .env
    chmod 600 -- .env
    TMP_ENV=''
    printf '[install] wrote .env (mode 600). SESSION_SECRET=%s, DASHBOARD_PASSWORD=%s (values never printed).\n' "$SESSION_SECRET_ACTION" "$DASHBOARD_PASSWORD_ACTION"
  fi
fi

# ---------------------------------------------------------------------------------------------
# Phase 2 — optional stack startup (prompt; default = generation only).
# ---------------------------------------------------------------------------------------------
ask 'First project name' 'default'
PROJECT_NAME=$ANSWER

HEALTH_PORT=$(grep '^PORT_MCP=' .env.example | head -n 1 | cut -d= -f2-)
if [ -z "$HEALTH_PORT" ]; then
  HEALTH_PORT=3000
fi
if [ "$ENV_ACTION" = "keep" ] && [ -n "$OLD_PORT_MCP" ]; then
  HEALTH_PORT=$OLD_PORT_MCP
fi

print_manual_steps() {
  printf '\nNext steps (run manually):\n'
  printf '  docker compose up -d db\n'
  printf '  docker compose run --rm app node dist/db/migrate.js\n'
  printf '  docker compose up -d\n'
  printf '  docker compose run --rm app node dist/cli.js list-projects\n'
  printf '  docker compose run --rm app node dist/cli.js create-project %s\n' "$PROJECT_NAME"
  printf '    (if "%s" is already listed above, use "rotate-token" instead — project names are\n' "$PROJECT_NAME"
  printf '     not unique, re-running create-project would mint a duplicate project + token)\n'
  printf '  curl -fsS localhost:%s/health\n\n' "$HEALTH_PORT"
}

start_stack() {
  # Explicit `if ! cmd; then return 1; fi` checks throughout (not bare `set -e` propagation) so a
  # failure here degrades gracefully to the manual-steps block instead of a raw stack trace.
  if ! docker compose up -d db; then
    printf '[install] "docker compose up -d db" failed.\n' >&2
    return 1
  fi

  printf '[install] waiting for db healthcheck ...\n'
  _swait=0
  _shealthy=0
  while [ "$_swait" -lt 60 ]; do
    _sstatus=$(docker compose ps db 2>/dev/null) || _sstatus=''
    case "$_sstatus" in
      *'(healthy)'*) _shealthy=1; break ;;
    esac
    _swait=$((_swait + 1))
    sleep 2
  done
  if [ "$_shealthy" -ne 1 ]; then
    printf '[install] WARNING: db did not report healthy within the timeout — continuing anyway.\n' >&2
  fi

  if ! docker compose up -d; then
    printf '[install] "docker compose up -d" failed.\n' >&2
    return 1
  fi

  printf '[install] running migrations ...\n'
  if ! docker compose run --rm app node dist/db/migrate.js; then
    printf '[install] migrations failed.\n' >&2
    return 1
  fi

  printf '[install] checking for an existing project named "%s" ...\n' "$PROJECT_NAME"
  LIST_OUTPUT=$(docker compose run --rm app node dist/cli.js list-projects) || LIST_OUTPUT=''
  if printf '%s\n' "$LIST_OUTPUT" | awk -F'\t' -v want="$PROJECT_NAME" '$3==want{found=1} END{exit !found}'; then
    printf '[install] project "%s" already exists — skipping create-project (avoids minting a duplicate; project names are not unique). Use "rotate-token %s" for a fresh token.\n' "$PROJECT_NAME" "$PROJECT_NAME"
    PROJECT_MINTED=no
  else
    if ! docker compose run --rm app node dist/cli.js create-project "$PROJECT_NAME"; then
      printf '[install] create-project failed.\n' >&2
      return 1
    fi
    PROJECT_MINTED=yes
  fi

  if command -v curl >/dev/null 2>&1 && curl -fsS "http://localhost:${HEALTH_PORT}/health" >/dev/null 2>&1; then
    HEALTH_STATUS=ok
  else
    HEALTH_STATUS=unknown
    printf '[install] NOTE: health check did not succeed (best-effort, non-fatal).\n' >&2
  fi
  return 0
}

DO_START=0
case "$START_MODE" in
  yes) DO_START=1 ;;
  no) DO_START=0 ;;
  ask)
    if [ "$DRY_RUN" -eq 0 ]; then
      if confirm 'Start the stack now (docker compose up + migrate + create first project)?' n; then
        DO_START=1
      fi
    fi
    ;;
esac

PROJECT_MINTED=no
HEALTH_STATUS=skipped
STACK_STARTED=no

if [ "$DRY_RUN" -eq 1 ]; then
  printf '[install] --dry-run: Phase 2 is not executed.\n'
  print_manual_steps
  STARTED_DISPLAY=dry-run
else
  if [ "$DO_START" -eq 1 ]; then
    if ! command -v docker >/dev/null 2>&1; then
      printf '[install] WARNING: "docker" not found on PATH — cannot start the stack automatically.\n' >&2
    elif start_stack; then
      STACK_STARTED=yes
    else
      printf '[install] Stack was NOT fully started — see warnings above.\n' >&2
    fi
  else
    printf '[install] Phase 2 skipped (generation only).\n'
  fi
  if [ "$STACK_STARTED" != "yes" ]; then
    print_manual_steps
  else
    printf '[install] project-minted=%s health=%s\n' "$PROJECT_MINTED" "$HEALTH_STATUS"
  fi
  STARTED_DISPLAY=$STACK_STARTED
fi

# ---------------------------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------------------------
if [ "$ENV_ACTION" = "keep" ]; then
  SUMMARY_MODE=$(profiles_to_mode "$OLD_COMPOSE_PROFILES")
  SUMMARY_PRESET=${OLD_EMBEDDING_PRESET:-unknown}
  SUMMARY_PROFILES=$OLD_COMPOSE_PROFILES
else
  SUMMARY_MODE=$EDGE_MODE
  SUMMARY_PRESET=$EMBEDDING_PRESET
  SUMMARY_PROFILES=$OUT_COMPOSE_PROFILES
fi

printf '[install] status=ok mode=%s preset=%s profiles=%s started=%s\n' \
  "$SUMMARY_MODE" "$SUMMARY_PRESET" "$SUMMARY_PROFILES" "$STARTED_DISPLAY"
