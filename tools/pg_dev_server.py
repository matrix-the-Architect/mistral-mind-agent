"""Keep an embedded PostgreSQL (pgserver) running for local Ghost development.

Writes the asyncpg URL to <state-dir>/url and then idles, so `bash tools/pg-dev.sh start` leaves a
Postgres up for `bunx nx run db:migrate` and `bun run dev` to connect to. The app's own venv is
irrelevant to this process — it only runs the postgres binaries; the app connects over the unix
socket with asyncpg.
"""

import json
import sys
import time
from pathlib import Path

import pgserver

STATE = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ghost-pg-dev")
STATE.mkdir(parents=True, exist_ok=True)

server = pgserver.get_server(str(STATE / "data"))
url = server.get_uri().replace("postgresql://", "postgresql+asyncpg://", 1)
(STATE / "url").write_text(url)
(STATE / "pid").write_text(str(server.get_pid()))
(STATE / "info.json").write_text(json.dumps({"url": url, "pid": server.get_pid()}, indent=2))
print(f"ghost dev postgres ready: {url}", flush=True)

try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    pass
