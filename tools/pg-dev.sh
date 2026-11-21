#!/usr/bin/env bash
# Embedded dev PostgreSQL for Ghost, for machines with no local Postgres and no docker.
#
#   bash tools/pg-dev.sh start     # start (or reuse) the embedded Postgres; prints its URL
#   bash tools/pg-dev.sh url       # print the asyncpg DATABASE_URL to export
#   bash tools/pg-dev.sh status    # whether it is running
#   bash tools/pg-dev.sh stop      # stop it
#
# Then, in the shell that runs the app:
#   export DATABASE_URL="$(bash tools/pg-dev.sh url)"
#   bunx nx run db:migrate         # creates the ghost_* tables (no prompt: upgrade heads)
#   bun run dev
#
# The URL uses a unix socket (?host=...), which asyncpg and the app's engine accept; the process
# env wins over the repo-root .env (non-overriding), so no file needs editing. pgserver needs a
# Python with published wheels (3.12 here), so it runs in its own uv environment — the app's
# .venv is untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE="${GHOST_PG_DEV_STATE:-/tmp/ghost-pg-dev}"
PID_FILE="$STATE/pid"
URL_FILE="$STATE/url"

alive() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start_server() {
  mkdir -p "$STATE"
  UV_PROJECT_ENVIRONMENT="${GHOST_PG_DEV_VENV:-/tmp/ghost-pg-dev-venv}" \
    nohup bash tools/uv.sh run --python 3.12 --with pgserver \
    python tools/pg_dev_server.py "$STATE" >"$STATE/log" 2>&1 &
  echo $! >"$STATE/launcher.pid"
  # Wait for the URL file (pgserver initdb takes a few seconds the first time).
  for _ in $(seq 1 60); do
    [ -f "$URL_FILE" ] && break
    sleep 1
  done
  [ -f "$URL_FILE" ] || { echo "embedded postgres did not start; see $STATE/log" >&2; exit 1; }
}

case "${1:-}" in
  start)
    if alive; then
      echo "already running: $(cat "$URL_FILE")"
    else
      start_server
      echo "started: $(cat "$URL_FILE")"
    fi
    ;;
  url)
    alive || { echo "not running; start it with: bash tools/pg-dev.sh start" >&2; exit 1; }
    cat "$URL_FILE"
    ;;
  status)
    if alive; then echo "running: $(cat "$URL_FILE")"; else echo "stopped"; fi
    ;;
  stop)
    if [ -f "$STATE/launcher.pid" ]; then kill "$(cat "$STATE/launcher.pid")" 2>/dev/null || true; fi
    if alive; then kill "$(cat "$PID_FILE")" 2>/dev/null || true; fi
    rm -f "$PID_FILE" "$URL_FILE"
    echo "stopped"
    ;;
  *)
    echo "usage: bash tools/pg-dev.sh {start|url|status|stop}" >&2
    exit 2
    ;;
esac
