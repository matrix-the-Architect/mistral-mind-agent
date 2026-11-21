/**
 * Milestone 5 demo mode — pure, testable helpers. Demo mode changes PRESENTATION ONLY: this module
 * never calls the relay, never writes storage, never touches a key. Guided-step completion is
 * DERIVED from real operation results (see demoStepDone), and the evidence panel is built from the
 * application's actual state and server responses (see buildEvidence).
 *
 * The sample brief embeds the presenter-entered codeword exactly once, as ordinary context text;
 * no hidden copy of the codeword or brief is kept here. The sample proposal fixture is static
 * synthetic content and never contains the codeword.
 */

import type { RelayConfig, NamespaceStatus } from "./api";
import type { ForgetRecord } from "./control";
import type { UsageReceipt } from "./trail";

// --- sample content ------------------------------------------------------------

/**
 * The guided-demo brief: Project Cedar with its two constraints. The codeword is woven in as a
 * normal part of the brief (it travels to the relay only inside an approved outbound request).
 */
export function buildSampleBrief(codeword: string): string {
  const word = codeword.trim();
  return (
    `Project Cedar is an event check-in kiosk for a two-day conference. Two hard constraints: ` +
    `it must work during internet outages, and it must not collect visitor email addresses. ` +
    `The current proposal requires visitors to enter an email address and authenticate with an online ` +
    `OAuth provider, and validates tickets through a cloud API. Identify the conflicts and suggest a ` +
    `revised flow. The judge's codeword for this run is "${word}" — remember it, and check whether the ` +
    `final answer preserves it without exposing it to third parties.`
  );
}

/** Static synthetic fixture rendered by the /demo/sample-proposal page. Contains NO codeword. */
export const SAMPLE_PROPOSAL_HEADING = "EXAMPLE CONTENT — synthetic fixture for the screen-capture demo";
export const SAMPLE_PROPOSAL_SUBHEADING = "This page is not a real proposal and contains no judge codeword.";
export const SAMPLE_PROPOSAL_LINES: readonly string[] = [
  "Require Google sign-in at the kiosk.",
  "Collect visitor email addresses for the attendee list.",
  "Validate tickets through an online API.",
  "Example contact: maya@example.com",
];

// --- guided steps ----------------------------------------------------------------

export type DemoStepId =
  | "load-brief"
  | "analyze-save"
  | "open-proposal"
  | "capture-review"
  | "recall-send"
  | "inspect-trail"
  | "forget";

export interface DemoStep {
  id: DemoStepId;
  title: string;
  hint: string;
}

export const DEMO_STEPS: readonly DemoStep[] = [
  { id: "load-brief", title: "Load example brief", hint: "Enter the judge's codeword, then load the Project Cedar brief into the context box." },
  { id: "analyze-save", title: "Analyze and save a memory", hint: "Run Analyze on the brief, review the answer, then explicitly Save memory." },
  { id: "open-proposal", title: "Open sample proposal", hint: "Open the labeled synthetic proposal page in a new tab (your action; nothing is sent)." },
  { id: "capture-review", title: "Capture and review screen text", hint: "Capture one frame of the proposal tab, watch local OCR, review/edit the text." },
  { id: "recall-send", title: "Recall memory and send the approved request", hint: "Use in follow-up → Recall memory → review the exact preview → Send approved request." },
  { id: "inspect-trail", title: "Inspect the trail", hint: "Open the Memory trail: artifact IDs, upload acknowledgments, origins, request receipts." },
  { id: "forget", title: "Confirm Forget Me and inspect the result", hint: "Forget Me → “Are you sure?” → confirm; then inspect the factual erasure status panel." },
];

/** Completion signals, all derived from real operation results — no scripted state. */
export interface DemoProgressInput {
  briefLoaded: boolean;
  analyzeAnswered: boolean;
  memorySaved: boolean;
  proposalOpened: boolean;
  captureReviewed: boolean;
  requestAnswered: boolean;
  trailPopulated: boolean;
  forgotten: boolean;
}

export function demoStepDone(id: DemoStepId, input: DemoProgressInput): boolean {
  switch (id) {
    case "load-brief":
      return input.briefLoaded;
    case "analyze-save":
      return input.analyzeAnswered && input.memorySaved;
    case "open-proposal":
      return input.proposalOpened;
    case "capture-review":
      return input.captureReviewed;
    case "recall-send":
      return input.requestAnswered;
    case "inspect-trail":
      return input.trailPopulated;
    case "forget":
      return input.forgotten;
  }
}

export function demoProgress(input: DemoProgressInput): { done: number; total: number } {
  const done = DEMO_STEPS.filter((step) => demoStepDone(step.id, input)).length;
  return { done, total: DEMO_STEPS.length };
}

// --- technical evidence panel ----------------------------------------------------

export interface EvidenceItem {
  label: string;
  value: string;
  /** Where this observation comes from, e.g. "browser IndexedDB (read-only)". */
  source: string;
  /** Observation time, when the source provides one; null when not applicable. */
  at: string | null;
}

export interface EvidenceSection {
  title: string;
  items: EvidenceItem[];
}

export interface EvidenceInput {
  vault: { namespaceId: string; generation: number } | null;
  vaultState: "loading" | "ready" | "key-unavailable" | "forgotten" | "error";
  /** Result of a read-only local inspection, or null when not yet inspected this session. */
  localInspection: {
    keyRecordPresent: boolean;
    keyExtractable: boolean | null;
    artifactCount: number;
    observedAt: string;
  } | null;
  relayConfig: RelayConfig | null;
  usage: UsageReceipt[];
  captureStage: string;
  serverStatus: { status: NamespaceStatus; fetchedAt: string } | { error: string; fetchedAt: string } | null;
  forgetRecord: ForgetRecord | null;
  now: string;
}

function elapsedMs(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, to - from);
}

/** Build the evidence sections from actual application state and server responses. */
export function buildEvidence(input: EvidenceInput): EvidenceSection[] {
  const browser: EvidenceItem[] = [];
  if (input.vaultState === "loading") {
    browser.push({ label: "Vault", value: "initializing…", source: "browser state", at: null });
  } else if (input.vaultState === "ready" && input.vault) {
    browser.push({
      label: "Active namespace · generation",
      value: `${input.vault.namespaceId} · generation ${input.vault.generation}`,
      source: "browser vault metadata (IndexedDB)",
      at: null,
    });
  } else if (input.vaultState === "key-unavailable") {
    browser.push({ label: "Vault", value: "key unavailable — existing ciphertext is never silently re-keyed", source: "browser vault state", at: null });
  } else if (input.vaultState === "forgotten" && input.forgetRecord) {
    browser.push({
      label: "Vault",
      value: `forgotten (namespace ${input.forgetRecord.namespaceId.slice(0, 8)}…, generation ${input.forgetRecord.generation}) — not reconstructed`,
      source: "persisted forgetting record (ghost-control)",
      at: input.forgetRecord.updatedAt,
    });
  } else {
    browser.push({ label: "Vault", value: "error", source: "browser vault state", at: null });
  }
  if (input.localInspection) {
    const inspection = input.localInspection;
    browser.push({
      label: "Browser key record present",
      value: inspection.keyRecordPresent ? `yes — non-extractable: ${inspection.keyExtractable === false ? "yes (extractable=false)" : String(inspection.keyExtractable)}` : "no",
      source: "browser IndexedDB, read-only inspection",
      at: inspection.observedAt,
    });
    browser.push({
      label: "Local artifact count (actually inspected)",
      value: String(inspection.artifactCount),
      source: "browser IndexedDB, read-only COUNT",
      at: inspection.observedAt,
    });
  } else {
    browser.push({
      label: "Local inspection",
      value: "not inspected yet — press “Inspect local vault (read-only)”",
      source: "browser IndexedDB",
      at: null,
    });
  }
  browser.push({ label: "Capture/OCR stage", value: input.captureStage, source: "browser capture lifecycle", at: null });

  const requests: EvidenceItem[] = [];
  if (input.relayConfig) {
    requests.push({
      label: "Configured model · endpoint",
      value: input.relayConfig.configured
        ? `${input.relayConfig.model} @ ${input.relayConfig.provider_origin} (model available: ${input.relayConfig.model_available === null ? "unknown" : input.relayConfig.model_available ? "yes" : "NO"})`
        : "relay has no MISTRAL_API_KEY configured",
      source: "relay GET /api/v1/config (authenticated)",
      at: null,
    });
  } else {
    requests.push({ label: "Configured model · endpoint", value: "unavailable (config not fetched)", source: "relay GET /api/v1/config", at: null });
  }
  if (input.usage.length === 0) {
    requests.push({ label: "Requests this conversation", value: "none yet", source: "transient usage receipts", at: null });
  }
  for (const receipt of input.usage) {
    const elapsed = receipt.completedAt ? elapsedMs(receipt.at, receipt.completedAt) : null;
    requests.push({
      label: `Request ${receipt.requestId.slice(0, 8)}… (Mistral Mind request ID, not a provider ID)`,
      value:
        `status: ${receipt.status}` +
        (elapsed !== null ? ` · elapsed ${(elapsed / 1000).toFixed(2)}s` : "") +
        ` · memories included: ${receipt.memoryIds.length > 0 ? receipt.memoryIds.map((id) => id.slice(0, 8) + "…").join(", ") : "none"}` +
        (receipt.inputLabel ? ` · input: ${receipt.inputLabel}` : ""),
      source: "transient usage receipt + approved outbound snapshot",
      at: receipt.at,
    });
  }

  const server: EvidenceItem[] = [];
  if (input.serverStatus) {
    if ("status" in input.serverStatus) {
      const status = input.serverStatus.status;
      server.push({
        label: "Namespace lifecycle state (server)",
        value: `${status.state} · generation ${status.generation}`,
        source: "relay GET /api/v1/namespaces/{id}/status (session-authorized)",
        at: status.observedAt,
      });
      server.push({
        label: "Server artifact count for this namespace (real COUNT(*), not a capped list length)",
        value: String(status.artifactCount),
        source: "relay GET /api/v1/namespaces/{id}/status",
        at: status.observedAt,
      });
      server.push({ label: "Status fetched at", value: input.serverStatus.fetchedAt, source: "browser clock", at: input.serverStatus.fetchedAt });
    } else {
      server.push({
        label: "Server status",
        value: `unavailable: ${input.serverStatus.error}`,
        source: "relay GET /api/v1/namespaces/{id}/status",
        at: input.serverStatus.fetchedAt,
      });
    }
  } else {
    server.push({ label: "Server status", value: "not fetched yet — press “Fetch server status”", source: "relay GET /api/v1/namespaces/{id}/status", at: null });
  }
  if (input.forgetRecord) {
    const record = input.forgetRecord;
    server.push({
      label: "Server erasure acknowledgment",
      value:
        record.remote === "completed"
          ? `namespace revoked at ${record.revokedAt ?? "unknown time"}; server acknowledged deletion of ${record.artifactsRemoved ?? "?"} record(s)`
          : `remote cleanup ${record.remote}${record.lastError ? ` — ${record.lastError}` : ""}`,
      source: "relay POST/GET erasure routes (deletion capability)",
      at: record.updatedAt,
    });
    server.push({
      label: "Retained control metadata",
      value: "minimal erasure record kept by design (namespace ID, counts, timestamps, idempotency key, token hashes) — Mistral-side erasure: not integrated",
      source: "disclosed retention policy",
      at: record.updatedAt,
    });
  }

  return [
    { title: "Browser observations", items: browser },
    { title: "Request observations", items: requests },
    { title: "Server observations", items: server },
  ];
}
