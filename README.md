![Mistral Mind — Screenshot 1](./Mistral_Mind_10.jpg)

![Mistral Mind — Screenshot 2](./Mistral_Mind_2.jpg)

![Mistral Mind — Screenshot 3](./Mistral_Mind_3.jpg)

![Mistral Mind — Screenshot 4](./Mistral_Mind_4.jpg)

![Mistral Mind — Screenshot 5](./Mistral_Mind_5.jpg)

![Mistral Mind — Screenshot 6](./Mistral_Mind_6.jpg)

![Mistral Mind — Screenshot 7](./Mistral_Mind_7.jpg)

**A Mistral-powered work companion with browser-encrypted memory, local screen-text extraction, and a visible Forget Me workflow.**

Built as a Mistral hackathon prototype, Mistral Mind helps you use work context without losing track of what the assistant remembers. Save a useful constraint, recall it in a new conversation, inspect the request that used it, and remove the app’s saved memory when you choose.

Screen pixels and memory encryption keys stay in the browser. **Approved text passes through the relay to Mistral for inference.** Saved memory is encrypted before upload.

## What it does

| Capability | How it works |
| --- | --- |
| Mistral assistance | Sends approved context to the configured Mistral model through an authenticated FastAPI relay. |
| Encrypted memory | Encrypts selected memories in the browser using AES-GCM before saving them locally or uploading them. |
| Recall | Decrypts up to three newest memories locally and shows their source IDs before reuse. |
| Screen context | Captures a user-selected screen, window, or tab and extracts text locally with Tesseract.js. The user can review and edit that text. |
| Memory trail | Shows a memory’s recorded origin and the current conversation’s requests that included it. |
| Forget Me | Removes the stored local key and memory, revokes the namespace, and deletes its server memory records. Remote cleanup can retry if offline. |
| Demo evidence | Shows local vault inspection, actual server memory counts, and scoped erasure results. |
| Optional read-aloud | Reads responses using an available local browser speech voice. |

## Quick start

### Prerequisites

- Bun.
- uv and a Python runtime compatible with the repository.
- A Mistral API key and an exact model ID available to your account.
- A desktop browser with screen-sharing support for the capture demo.

Run these commands from the repository root:

```bash
bun run install-all

export MISTRAL_API_KEY='your-api-key'
export MISTRAL_MODEL='your-enabled-model-id'
export MISTRAL_BASE_URL='https://api.mistral.ai'

bun run dev
```

Replace the two placeholder values with your own credentials and model ID. Set the environment variables in the shell that launches the development server, and restart it after changing them.

The development launcher starts the web app on port **3001** and the API on **127.0.0.1:3000**. Its PostgreSQL helper provisions and migrates a local development database when no existing development instance is available.

### Open the app

| Route | Purpose |
| --- | --- |
| [http://localhost:3001/ghost](http://localhost:3001/ghost) | Reference UI from the completed implementation milestones. |
| [http://localhost:3001/mistral_mind](http://localhost:3001/mistral_mind) | Optional alternate UI, when included in your checkout. Use the reference route if this page is unavailable. |

The alternate UI uses the same application services. Routes on the same browser origin share the vault: **Forget Me from either UI removes that shared memory.** Use a separate browser profile for an independent demo dataset.

### Configuration

| Variable | Purpose |
| --- | --- |
| `MISTRAL_API_KEY` | Provider credential, read only by the server. |
| `MISTRAL_MODEL` | Exact accessible model ID. The relay checks availability against the configured provider origin. |
| `MISTRAL_BASE_URL` | Provider origin. The standard configuration uses `https://api.mistral.ai`. |
| `DATABASE_URL` | Database connection when configuring a PostgreSQL instance explicitly. |

Keep the provider API key out of browser configuration, `VITE_*` variables, screenshots, and committed files. The memory encryption key is a separate browser-held key.

The development script configures the browser’s local API address. Follow its startup output if you use a custom database or development configuration.

## Judge demo

Use a codeword chosen by someone watching the demo so recall is easy to distinguish from a prewritten answer.

1. **Enter context.** Paste a brief into the context editor, or the top User input textbox if the alternate UI includes it:

   ```text
   Project Cedar needs an event check-in workflow that works offline.
   Do not collect email addresses.
   Prefer a simple QR or PIN process.
   Remember this codeword: YOUR_CODEWORD.
   ```

2. **Analyze.** Get a real Mistral response. Review or edit the memory you want to retain.
3. **Save memory.** Confirm the local save and actual upload acknowledgement.
4. **Start a new conversation.** Clear the conversation while keeping the saved memory.
5. **Introduce a conflicting proposal.** Capture the sample proposal page, another test document, or paste a proposal that requires an online login and an email address. Review the locally extracted text before using it.
6. **Recall and review.** Prepare the follow-up request with memory. Inspect the exact text and memory IDs, then send the approved request. Ask Mistral to identify conflicts and recall the codeword.
7. **Inspect the trail.** Show the saved memory’s origin, its artifact ID, and the request that included it. Open Technical evidence to show the actual storage status.
8. **Forget.** Confirm Forget Me. Show local removal and the real server result. If remote cleanup is offline, show its pending/retry state.
9. **Reload.** Confirm the forgotten state persists. Start a new session and verify that the previous memory and codeword are absent.

The reference implementation also provides an explicitly labeled fixture at `/demo/sample-proposal` for the screen-capture demonstration.

## How it works

```mermaid
flowchart LR
    B["Browser"] -->|Approved inference text| R["FastAPI relay"]
    R --> M["Mistral API"]
    B -->|Encrypted memory| A["Memory API"]
    A -->|Ciphertext and lifecycle metadata| D["PostgreSQL"]
    D -->|Stored ciphertext| A
    A -->|Ciphertext for local recall| B
```

### Browser

- Uses a browser-held, non-extractable AES-GCM 256-bit key stored in IndexedDB.
- Encrypts each saved memory with a fresh 12-byte IV and authenticated metadata binding it to its namespace, generation, and artifact ID.
- Stores memory content and its provenance inside the encrypted payload.
- Runs screen-text extraction with locally served Tesseract assets.
- Builds the outbound preview and invalidates it when its inputs change.
- Checks the active namespace and generation before applying async results, so late work cannot restore forgotten content.

### Backend

- Holds the Mistral API credential on the server.
- Authenticates session requests and checks namespace ownership, lifecycle state, and generation.
- Stores ciphertext envelopes plus authentication, routing, and lifecycle metadata.
- Uses a separate deletion capability for erasure and its retry/result flow.
- Coordinates writes and erasure with database transactions and locks.
- Returns actual namespace artifact counts for the evidence panel.

The backend is stateful for authentication, memory storage, revocation, and erasure records. The inference relay handles approved plaintext while forwarding it to Mistral.

## What Forget Me removes

| Data or state | Result |
| --- | --- |
| Stored browser memory key | Key record removed. |
| Local encrypted memories and vault metadata | Removed from the local vault. |
| Current conversation, previews, extracted text, and transient receipts | Cleared from the UI. Capture, OCR, and speech work is cancelled or cleaned up. |
| Server memory records for the namespace | Deleted when remote erasure succeeds. |
| Namespace | Revoked so stale writes cannot reactivate it. |
| Offline remote cleanup | Kept pending with retry support that survives reload. |
| Minimal control metadata | Retry/erasure records, revocation state, and credential hashes remain as disclosed by the application. |
| Mistral-held content and infrastructure backups | Outside the implemented erasure result; provider coordination and verified backup retention remain future work. |

**A remaining count of zero means zero server memory rows for that namespace.** It is not a claim of forensic erasure from every device, physical backup, or provider system.

### Provider-erasure demo

A checkout may include a clearly labeled simulated provider-erasure timeline after Forget Me. Its prepared, queued, acknowledged, processing, and completed stages are demonstration states.

**The simulation sends no email, makes no provider deletion request, and does not confirm deletion by Mistral.** Its result is separate from the real local/server erasure evidence. A simulation can complete while actual offline server cleanup remains pending.

## Privacy boundaries and prototype limits

- Raw screen frames and memory encryption keys remain in the browser; approved text reaches the relay and Mistral.
- The deterministic demo redactor is limited and does not guarantee comprehensive PII detection. Review outgoing text.
- Browser scripts and device security remain part of the trust boundary. A non-extractable key does not make an actively compromised browser safe.
- Memory origins are app-generated provenance. Request-use receipts cover the current conversation; this is not a complete or tamper-proof compliance audit log.
- Recall currently selects recent memories. Vector search and “orthogonal encryption” are not implemented.
- Capture is user-triggered. Continuous screen monitoring, autonomous background assistance, and microphone input are outside the MVP.
- The prototype does not claim GDPR certification, guaranteed EU residency, or a universal 30-day deletion guarantee.

## Technology and code map

| Area | Stack or location |
| --- | --- |
| Web application | TanStack Start, React, TypeScript, Bun |
| Browser security and storage | Web Crypto API and IndexedDB |
| Screen context | Screen Capture API and Tesseract.js |
| API | FastAPI and Python, managed with uv |
| Database | PostgreSQL with Alembic migrations |
| Browser implementation | `apps/web/src/ghost/` |
| Reference route | `apps/web/src/routes/ghost.tsx` |
| API routes | `apps/api/src/api/routers/api/v1/` |
| Memory models and accessors | `packages/py/db/src/db/models/ghost_memory.py` and `packages/py/db/src/db/accessors/ghost_memory.py` |
| Development launcher | `tools/dev.sh` |

Some internal paths retain the prototype’s original `ghost` name. The product is **mistral mind**.

## Validation

### Web checks

From `apps/web`:

```bash
bun test --preload ./src/test/setup.js
bunx tsc --noEmit -p tsconfig.json
bun run build
```

### API and generated-client checks

From the repository root:

```bash
bash tools/uv.sh run --with pytest --with aiosqlite python -m pytest apps/api/tests packages/py -q
bash tools/gen-types.sh --check
```

PostgreSQL contract coverage is available through `RUN_PG_CONTRACT=1` in the test environment with `pgserver` installed.

### Reported milestone 5 baseline

| Check | Reported result before the final UI changes |
| --- | --- |
| Web tests | 108 passed |
| TypeScript and web build | Passed |
| API suite using SQLite fixtures | 92 passed, 4 skipped, 2 pre-existing failures |
| PostgreSQL contract suite | 13 passed |
| Generated API client | In sync |

The two pre-existing API failures were attributed to missing async pytest support in that environment. Rerun the relevant checks after changes; these baseline results do not verify later UI work.

Real-browser acceptance still needs to cover permission grant/denial, OCR on an actual frame, IndexedDB persistence, cross-tab forgetting, local read-aloud where available, and the complete live demo. Mock tests do not replace those checks.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing provider key or unavailable model | Set server environment variables before starting the app, use an accessible model ID, and restart the server. |
| Missing `Authorization: Bearer` header | The app’s API requires its session credential. Use the browser bootstrap flow; do not put the Mistral API key in browser requests. A direct unauthenticated config request can be rejected normally. |
| Send is disabled after editing text | Prepare a fresh outbound preview. In the reference UI, use Recall memory, inspect the preview, then Send approved request. |
| Database connection refused | Start through `bun run dev` so the development database helper can run, or configure the intended database explicitly. |
| Screen sharing denied | Retry the permission picker or paste the context manually. |
| Forget Me reports pending remote cleanup | Local forgetting and remote cleanup have separate outcomes. Restore connectivity and use the retry flow. |
| Memory key unavailable | Existing ciphertext cannot be decrypted without its key. The application deliberately avoids silently replacing the missing key. |

## Next steps

- Complete browser acceptance across the supported demo environments.
- Strengthen local redaction and its evaluation.
- Add real provider-erasure coordination with verifiable outcomes.
- Define and verify backup retention and deployment data residency.
- Improve retrieval as the memory collection grows.

