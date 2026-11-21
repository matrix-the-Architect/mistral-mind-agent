# Mistral Mind — Guided walkthrough + technical evidence

Milestones 1–2 delivered browser-encrypted local memory, authenticated remote ciphertext storage,
and Forget Me. This milestone adds a **Memory trail** panel that makes that behavior inspectable
during a live demo — with no new services, no graph dependencies, and no plaintext audit store:

- For each saved memory it shows the decrypted text (expandable), its artifact ID, its real
  local/uploading/**uploaded (relay acknowledged)**/awaiting-upload status, its origin, and whether
  it was included in any request **this conversation** (transient usage receipts, each with an
  expandable view of the exact approved outbound snapshot).
- New memories record minimal **creation provenance inside the encrypted payload** (backward
  compatible — old ciphertext decrypts unchanged, no migration): `sourceKind`
  (`user-entered`/`saved-from-analysis`), `sourceAnalysisId` (an app-generated **Mistral Mind ID**, labeled
  as such — not a Mistral request ID), `createdAt`, and `editedBeforeSave`. Records saved before
  this milestone show **“Origin not recorded.”** — nothing is fabricated.
- Forget Me now asks **“Are you sure?”** first (Cancel aborts; you are not forced into a new session).
  It clears decrypted cards, origin details, usage receipts and expanded previews; the factual
  erasure panel and its retained-metadata disclosure stay.
- The header keeps showing the configured model and provider origin via the authenticated config
  flow; model availability is not presented as proof of a successful inference.

## Stack

- `apps/web` — TanStack Start (React + Vite + TypeScript), page at `/Mistral Mind`, fixed dev port
  **3001 with `strictPort`** (IndexedDB is origin-scoped, so the origin must stay stable).
- `apps/api` — FastAPI relay on **127.0.0.1:3000** (localhost only). Routes (all under `/api/v1`):
  - `POST /sessions` — anonymous demo session bootstrap (the only anonymous v1 endpoint); returns a
    random bearer token **once**; the server stores only its SHA-256 hash.
  - `GET /config`, `POST /inference` — relay configuration + model availability, and the Mistral
    call (session token required; the namespace is checked for ownership/active state/generation in
    a short transaction *before* any provider call — no DB transaction is held across the network).
  - `POST /namespaces` — register the vault's `(namespaceId, generation)`; binds an unclaimed
    namespace to the session and issues the **deletion capability** (returned once, hash stored).
  - `POST|GET /namespaces/{id}/artifacts[/{artifact_id}]` — upload (idempotent), list, fetch encrypted
    envelopes. Writes take the namespace row lock (`SELECT ... FOR UPDATE` on PostgreSQL) in one
    transaction and check owner/active/generation.
  - `POST /namespaces/{id}/erase`, `GET /namespaces/{id}/erasure` — deletion-capability only; one
    locked transaction revokes the namespace, deletes its artifacts, records the minimal erasure
    result; replays return the same completed result even after ordinary access is revoked.
- Web Crypto (AES-GCM 256, fresh 12-byte IV per encryption, AAD binding
  `Mistral Mind-memory/v1|schema|namespace|generation|artifact`) + IndexedDB: database `Mistral Mind-vault`
  (`vault`/`keys`/`artifacts` stores — ciphertext envelopes containing only `namespaceId`,
  `generation`, `artifactId`, `schemaVersion`, `iv`, `ciphertext`, plus the non-extractable
  CryptoKey) and a **separate** database `Mistral Mind-control` (relay session credential, per-namespace
  deletion capability, forgetting records — kept outside the memory that gets deleted).
- Persistence server-side: the app's SQLAlchemy/`db` package on PostgreSQL (`DATABASE_URL`),
  tables `Mistral Mind_session`, `Mistral Mind_namespace`, `Mistral Mind_artifact`, `Mistral Mind_erasure` (Alembic migration
  `9d2f629e6640`, branch label `Mistral Mind-memory`). Only ciphertext + routing/authz/lifecycle metadata
  is stored; memory text and provenance live inside the encrypted content.
- Package managers: **bun** (JS) and **uv** (Python), as scaffolded.

## Setup

```bash
bun run install-all          # uv sync + bun install + generated API client (first run)
cp .env.example .env         # then put your real values in .env (gitignored):
#   MISTRAL_API_KEY=...      # never read into the browser, code, or logs
#   MISTRAL_MODEL=mistral-medium-latest
#   MISTRAL_BASE_URL=https://api.mistral.ai   # optional; a regional origin is never silently
#                                             # swapped for the global endpoint
```

`.env.example` declares `MISTRAL_API_KEY`, `MISTRAL_MODEL`, `MISTRAL_BASE_URL` (names only).

### Database

The relay stores Mistral Mind's ciphertext server-side in PostgreSQL (`DATABASE_URL`). `db:migrate`
applies all heads with `alembic upgrade heads` — **it never prompts for a revision**; the
`(base)` selection prompt only exists in `db:downgrade`. If `bunx nx run db:migrate` fails with
`ECONNREFUSED` on `localhost:5432`, no Postgres is listening there.

On a machine with a real Postgres, point `DATABASE_URL` at it and run:

```bash
bunx nx run db:migrate       # creates Mistral Mind_session / Mistral Mind_namespace / Mistral Mind_artifact / Mistral Mind_erasure
```

On a machine with **no local Postgres and no docker**, use the embedded dev Postgres (pgserver,
runs under its own uv-managed Python 3.12 env; your `.venv` is untouched):

```bash
bash tools/pg-dev.sh start                       # start (or reuse) the embedded Postgres
export DATABASE_URL="$(bash tools/pg-dev.sh url)"  # process env wins over the .env default
bunx nx run db:migrate
bun run dev                                      # run this in the same shell (export persists)
# bash tools/pg-dev.sh stop                      # when done
```

State lives in `/tmp/Mistral Mind-pg-dev` (override with `Mistral Mind_PG_DEV_STATE`); nothing in the repo is
modified.

## Run

```bash
bun run dev                  # one command: web on http://localhost:3001 + relay on 127.0.0.1:3000
```

`tools/dev.sh` handles the database by itself: an exported `DATABASE_URL` always wins; otherwise,
if nothing listens where the `.env` `DATABASE_URL` points (e.g. `localhost:5432` with no local
Postgres), it starts/reuses the embedded dev Postgres (`bash tools/pg-dev.sh start`), runs
`db:migrate` on it, and points the relay at it — no manual export needed. With a real Postgres
reachable, it just uses the `.env` value. (`bash tools/pg-dev.sh stop` stops the embedded one.)

Open http://localhost:3001 (redirects to `/Mistral Mind`). The dev script seeds `apps/web/.env` from
`apps/web/.env.example`, which points the browser at the relay directly
(`VITE_API_URL=http://127.0.0.1:3000`, CORS-allowed by the API) — the scaffold's documented
split-port mode. On first load the page creates an anonymous relay session (token kept in the
`Mistral Mind-control` IndexedDB, sent only as an `Authorization: Bearer` header) and registers the
vault's namespace, receiving the deletion capability.

Production build of the web app: `bunx nx run web:build` (or `cd apps/web && bun run build`).

## Manual browser script (milestone 5 judged demo — run in a DEDICATED browser profile with synthetic data)

Prereq: `bun run dev` with a configured `MISTRAL_API_KEY`; use a fresh browser profile (or Forget Me →
Start new session first) so no real vault is touched by the demo.

1. Toggle **Demo mode** in the header — this changes presentation only (no request, no save, no
   erasure, no auth change; verified by tests that demo.ts has no network/storage side effects).
2. **Step 1**: the judge announces a codeword; type it and click **Load brief into context** — the
   Project Cedar brief (offline-capable, no email collection) with the codeword lands in the normal
   context box. The codeword field is cleared and never reseeded after New conversation/Forget Me/reload.
3. **Step 2**: **Run Analyze** → review the exact outbound preview → **Save memory** (section 2) →
   *uploaded (relay acknowledged)*.
4. **Step 3**: **Open sample proposal** — `/demo/sample-proposal` opens in a new tab: large synthetic
   text, banner-labeled EXAMPLE CONTENT, no codeword (Google sign-in / collect emails / online API /
   maya@example.com).
5. **Step 4**: back on Mistral Mind, **Capture screen context** on that tab → local OCR progress → review/edit
   the extracted text → **Use in follow-up** (invalidates any prior approval). OCR failure never
   substitutes the fixture text.
6. **Step 5**: **Recall memory** → inspect the approved preview (reviewed text + memory IDs only) →
   **Send approved request** → answer appears; optionally **Read answer aloud (local voice)**.
7. **Step 6**: inspect the **Memory trail** (artifact IDs, origins, upload states, request receipts)
   and the **Technical evidence** panel: browser (namespace/generation, key record present +
   non-extractable via read-only inspection, local artifact count, capture stage), requests (Mistral Mind
   request IDs, status, elapsed, model/endpoint, included memory IDs), server (lifecycle state, real
   COUNT(*) artifact count with observation time via `GET /api/v1/namespaces/{id}/status`, erasure
   acknowledgment + retained metadata). Every item names its source and observation time.
8. **Step 7**: **Forget Me → “Are you sure?” → Yes** → the factual erasure panel (local key/records
   removed, server revoked + N records removed per the erasure result, retained control metadata,
   Mistral-side erasure not integrated). Demo-held content and speech are cleared; the checklist
   step completes from the real erasure state.
9. **Reload** → forgotten state, nothing reconstructed; **Start new session** → new namespace/key,
   no old memory IDs, and the codeword does not reappear.

## Manual browser script (milestone 4 demo sequence)

Prereq: `bun run dev` with a configured `MISTRAL_API_KEY`; header shows
`Relay ready: model … @ https://api.mistral.ai (model available: yes)`.

1. Save a constraint memory first (Analyze → edit → **Save memory**), so the follow-up has
   something to check against.
2. Click **Capture screen context** in section 3 and pick a screen/tab/window showing a proposed
   workflow (e.g. a doc or whiteboard with steps). One frame is captured; all capture tracks stop
   before OCR; the status line shows *Extracting text locally in your browser… NN%* with a
   **Cancel OCR** action. The worker/WASM/language assets are served locally from `/ocr/*`.
3. The review panel appears, labeled **Text extracted locally from your screen**. Edit the text if
   needed. Nothing has been sent to Mistral and no memory was saved.
4. Click **Use in follow-up** — the follow-up question becomes
   `Review this proposed workflow against my saved constraints:` + your reviewed text, and any
   previously approved outbound preview is invalidated.
5. Click **Recall memory**, review the exact outbound preview (it contains the reviewed text and
   the selected memory IDs — no screenshot data, ever), then **Send approved request**. The Memory
   trail receipt for that request is labeled *input: Text extracted locally from your screen*.
6. **Permission denial fallback**: click **Capture screen context** and dismiss/deny the browser
   picker → a readable message appears; paste the text into the follow-up box instead.
7. **Forget Me during OCR**: start a capture, and while OCR is running click **Forget Me** →
   confirm. The late OCR result is discarded and never repopulates the panel; the capture tracks
   and worker are torn down; the factual erasure panel appears as in milestone 2/3. A stream granted
   after the picker was cancelled mid-Forget-Me is stopped immediately and discarded.
8. **Reload after forgetting** → forgotten state, no old content; **Start new session** → new
   namespace/key with none of the old memory IDs.

## Manual browser script (milestone 3 demo sequence)

Prereq: `bun run dev` with a configured `MISTRAL_API_KEY` (see Setup); header shows
`Relay ready: model … @ https://api.mistral.ai (model available: yes)`.

1. The judge chooses an arbitrary project codename or constraint (e.g. "the codename is Juniper").
2. Click **Analyze** — Mistral Mind sends the prefilled Project Cedar brief through the configured model
   and shows the exact outbound preview plus the answer.
3. Edit the suggested memory (append the judge's codename) and click **Save memory** — the memory
   row shows *uploading…* then **uploaded (relay acknowledged)**.
4. The **Memory trail** panel shows the memory expandable: decrypted text, artifact ID, upload
   status, and origin — *saved from analysis · Mistral Mind analysis ID … · edited before save · created …*.
5. **Hard reload**, **New conversation**, type a question, **Recall memory**, **Send approved
   request** — after reload the saved fact is recalled and decrypted; the approved request in the
   trail shows the included memory ID and its expandable approved payload ("Included in request").
6. Click **Forget Me** → confirm **“Are you sure?”** (Cancel leaves everything intact; you may also
   simply not start a new session afterwards). The trail, decrypted cards, origin details and usage
   receipts are cleared; the status panel still shows the scoped erasure result and retained
   control metadata, with Mistral-side erasure labeled *not integrated*.
7. **Reload** after forgetting → the app opens in the forgotten state (no vault reconstruction).
8. **Start new session** → a new namespace and key; the Memory trail contains none of the old
   memory IDs or context.

Older milestone-2 checks (remote recall by clearing only the local artifact cache, offline Forget
Me + retry after reload, delayed-request discard, two-profile isolation) still apply — see the
previous script below.

## Manual browser script (milestone 2)

1. Open http://localhost:3001/Mistral Mind. The Project Cedar brief is prefilled; the header shows the
   vault namespace/generation and the relay line shows **model + provider origin**
   (`mistral-medium-latest @ https://api.mistral.ai` unless configured otherwise).
2. Click **Analyze**; the outbound preview shows the exact messages array that was sent.
3. Edit the seeded memory text, click **Save memory**: the panel row shows *uploading…* then
   **uploaded (relay acknowledged)** (only after the relay accepts the ciphertext).
4. **Hard reload** (Cmd/Ctrl+Shift+R): same namespace/generation; the memory row still shows
   *uploaded* (the panel compares local artifacts with the relay's list).
5. **Remote recall demo**: DevTools → Application → IndexedDB → `Mistral Mind-vault` → `artifacts` →
   delete the artifact records (keep `keys` and `vault`!). Click **Fetch remote copies**, then
   **Recall memory** — the memory decrypts and appears with its artifact ID.
6. **Forget Me**: click the red **Forget Me** button. The status panel shows, separately: browser key
   record removed, local memory records removed, server namespace revoked, server memory records
   removed, remote cleanup completed/pending, minimal erasure/control metadata retained, and
   "Mistral-side erasure: not integrated". To see the offline path: DevTools → Network → Offline,
   reload, Forget Me again in a fresh session → panel shows **Remote cleanup: pending/failed** with a
   **Retry remote deletion** button that survives reload; go back online and retry → completed.
7. **Reload after forgetting**: the page opens directly in the forgotten state (no vault is
   reconstructed); click **Start new session** → a new namespace and key appear, with no old
   memories, and the old namespace stays revoked server-side.
8. **Delayed-request demonstration**: start an **Analyze** call, click **Forget Me** while it is in
   flight (or block the network briefly). The late answer is discarded — nothing is displayed or
   saved, and the panel notes the vault changed. (An inference request already sent to Mistral
   cannot be recalled by local deletion; its result is dropped, never stored.)
9. **Two sessions**: open a second browser profile (or incognito) at the same URL — it gets its own
   session/namespace; it cannot read, write, or erase the first session's memory (relay answers
   403/404), and forgetting one leaves the other intact.

## Tests

```bash
# web (vault/crypto/redactor/outbound + milestones 2–5 remote/forget/trail/capture/demo suites: 108 tests)
cd apps/web && bun test --preload ./src/test/setup.js
cd apps/web && bunx tsc --noEmit -p tsconfig.json          # type checking
cd apps/web && bun run build                               # production build
bash tools/gen-types.sh --check                            # generated client matches the API spec

# API, default scratch SQLite (aiosqlite overlay):
bash tools/uv.sh run --with pytest --with aiosqlite python -m pytest apps/api/tests packages/py -q

# API against a throwaway REAL PostgreSQL (pgserver, Python 3.12 env; exercises FOR UPDATE races):
RUN_PG_CONTRACT=1 UV_PROJECT_ENVIRONMENT=/tmp/Mistral Mind-pg-venv \
  bash tools/uv.sh run --python 3.12 --with pgserver --with pytest \
  python -m pytest apps/api/tests/test_Mistral Mind_memory.py apps/api/tests/test_Mistral Mind_relay.py -q

# Migration contract on scratch PostgreSQL (upgrade heads -> alembic check -> downgrade base):
# see packages/py/db/tests/test_migrations_pg.py behind RUN_PG_CONTRACT=1 + DATABASE_URL.
```

Pre-existing failures (unrelated to Mistral Mind, present before this milestone): two async tests
(`apps/api/tests/test_postgres_hooks.py::test_postgres_hooks_expose_report_and_readiness_results`,
`packages/py/db/tests/test_db_engine.py::test_probes_answer_false_when_postgres_is_unreachable`)
fail in the default environment because no async pytest plugin is installed there
("async def functions are not natively supported"); they pass with `--with pytest-asyncio`
except the latter, which also needs a plugin mode config. The `RUN_PG_CONTRACT` migration suite
self-skips without a live Postgres.

## Security notes

- All `/api/v1` routes except `POST /sessions` require a bearer credential (group access rule in
  `apps/api/src/api/routers/api/v1/__init__.py`). Session tokens own namespaces and can read/write
  memory and call inference; the deletion capability is a separate token that can only erase its own
  namespace and read the erasure result — and it keeps working after the namespace is revoked.
  Only SHA-256 hashes of both are stored server-side; tokens never appear in URLs, bodies, or logs
  (verified against the live server's logs).
- A namespace UUID or owner ID supplied in a request is not authorization: every operation resolves
  ownership from the bearer token server-side.
- Artifact writes and erasure share the namespace row lock, so a write committed before erasure is
  deleted by it, and a write arriving after revocation is rejected (409). Erasure is one DB
  transaction: lock → verify capability → revoke → delete artifacts → record erasure result → commit;
  a failed transaction is reported as pending/failed, never as success. Replays (lost response) get
  the same completed result via the idempotent erase route or the erasure-result route.
- Envelope fields are validated (UUIDs, schema version 1, base64 IV of exactly 12 bytes, ciphertext
  size cap, 512 KiB body cap, `extra="forbid"`); uploads are idempotent per artifact ID (identical
  replay → 200 `exists`, different ciphertext → 409).
- The browser keeps the non-extractable AES-GCM key; the relay stores only ciphertext. The relay
  still loads the Mistral key only from its own environment, uses only the configured origin/model
  (checked against `/v1/models` on that same origin, no silent global fallback), rejects
  browser-supplied provider config (422), caps bodies (64 KiB → 413 on inference), maps provider
  errors readably, and never logs request/response bodies or credentials.
- The browser never sees the API key (verified by scanning the built bundle).
- Tampered ciphertext fails AES-GCM authentication → "unreadable record"; a missing key with existing
  ciphertext shows **"Memory key unavailable."** and never regenerates or falls back to plaintext.
- The outbound preview applies a small **demonstration redactor** (labeled as not comprehensive PII
  detection) and is byte-identical to what is sent. Answers render as plain text.
- Forget Me: local wipe happens in one awaited IndexedDB transaction and does not wait for the
  network (offline forgetting works; remote shows pending + retry that survives reload). Every async
  operation captures the immutable `(namespaceId, generation)` pair and re-checks **both** fields
  before displaying/saving/uploading — a new namespace may also start at generation 1. Other open
  tabs are notified via `BroadcastChannel` and stop using the old vault. This is not forensic wiping
  of all browser memory.
- Screen capture (milestone 4): `getDisplayMedia({video:true, audio:false})` is called directly in
  the click handler; exactly one frame is drawn to a local canvas and **all tracks stop before
  OCR starts** (and on error/cancel). OCR is Tesseract.js (English, LSTM) loaded by dynamic import
  and run entirely in the browser with locally served assets from `/ocr/*` — no CDN, no remote OCR,
  and screenshots/image bytes/data URLs never reach API requests, logs, IndexedDB, or caches; the
  recognized text is never logged. The extracted text stays in a separate editable preview until
  **Use in follow-up**, which invalidates any prior approval; capture/OCR itself triggers no
  inference and saves no memory. Every async capture result is gated on the same
  `(namespaceId, generation)` pair + capture operation ID + mounted + not-forgetting check, and a
  stream granted after cancel/Forget-Me is stopped immediately and discarded.
- Demo mode (milestone 5) is presentation-only: one switch reveals a guided 7-step checklist whose
  completion is derived from real operation results, plus a Technical evidence panel built from actual
  state and server responses (each item labeled with source + observation time). Guided actions call
  the same handlers and backend as normal mode — no mock backend. The sample brief embeds the judge's
  codeword once as ordinary context (cleared with the conversation lifecycle, never reseeded); the
  `/demo/sample-proposal` fixture page is static, banner-labeled example content and never contains
  the codeword. Local inspection is a readonly get/count transaction — it cannot create a key or
  reconstruct a forgotten vault. `GET /api/v1/namespaces/{id}/status` is owner-scoped (session
  principal decides; another session gets the same 404 as a nonexistent namespace; deletion
  capability gets 403) and returns lifecycle state plus a live per-namespace COUNT(*) with
  observation time — never a capped list length or global count. The erasure result now also carries
  `artifacts_remaining`, a real post-delete COUNT(*) from the same transaction.
- Read answer aloud (milestone 5 optional): browser speech synthesis with an explicitly selected
  `localService === true` voice only — never a remote voice, never microphone access; voices are
  awaited (`voiceschanged`, bounded), the start is re-guarded on the active (namespaceId, generation)
  pair, and speech is cancelled on Forget Me / New conversation / new session / unmount / cross-tab
  forgetting.
- **Deletion scope / retained metadata**: erased are the browser's CryptoKey record, local artifact
  envelopes, vault metadata, and the server's artifact rows for the namespace; the namespace is
  marked revoked. **Retained by design**: the local forgetting record and the server's scoped
  erasure record (namespace ID, generation, artifact count, timestamps, idempotency key, token
  hashes) — the disclosed control metadata proving revocation. **Not done**: Mistral-side erasure
  (no provider deletion request exists or is claimed), and no claim is made that every
  user-associated record is gone while this control metadata remains.

## Handoff: where to extend next

- Accounts/OAuth, provider erasure requests, backup retention, voice input, embeddings, orthogonal
  transforms, workflow engines, continuous/background capture: later milestones.
- Multi-generation vaults (bump `generation` and re-encrypt under a new AAD) can now be built on
  the revocation machinery: the server already rejects writes at a stale generation and refuses to
  reactivate revoked namespaces.
