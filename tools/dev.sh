#!/usr/bin/env bash
# Ghost's one development command: the web app on http://localhost:3001 (fixed, strict port)
# and the API relay on http://127.0.0.1:3000, with the dev server proxying /api to the relay.
set -euo pipefail
cd "$(dirname "$0")/.."

# The web app's documented split-port dev mode points the browser straight at the relay
# (CORS-allowed), so seed the gitignored apps/web/.env from the committed example on first run.
if [ ! -f apps/web/.env ]; then
  cp apps/web/.env.example apps/web/.env
fi

# --- relay database ---------------------------------------------------------------
# An exported DATABASE_URL always wins. Otherwise the app would fall back to the .env default
# (localhost:5432); if nothing listens there (no local Postgres installed), start/reuse the
# embedded dev Postgres (tools/pg-dev.sh) and migrate it, so `bun run dev` works out of the box.
if [ -z "${DATABASE_URL:-}" ]; then
  db_reachable="$(bash tools/uv.sh run --no-sync python -c '
import socket
from urllib.parse import urlparse
from env.db import env

parsed = urlparse(env.async_database_url)
host = parsed.hostname or "localhost"
port = parsed.port or 5432
for candidate in dict.fromkeys([host, "127.0.0.1", "::1"]):
    try:
        socket.create_connection((candidate, port), timeout=0.5).close()
        print("yes")
        break
    except OSError:
        continue
else:
    print("no")
')"
  if [ "$db_reachable" != "yes" ]; then
    echo "[dev] nothing listens at the .env DATABASE_URL; using the embedded dev Postgres" >&2
    bash tools/pg-dev.sh start >&2
    export DATABASE_URL="$(bash tools/pg-dev.sh url)"
    bash tools/db.sh migrate >&2
    echo "[dev] relay database ready at $DATABASE_URL" >&2
  fi
fi

bash tools/uv.sh run --no-sync python -m api.dev &
API_PID=$!
(cd apps/web && bun run dev) &
WEB_PID=$!

trap 'kill "$API_PID" "$WEB_PID" 2>/dev/null || true' EXIT INT TERM
wait -n "$API_PID" "$WEB_PID" 2>/dev/null || wait
