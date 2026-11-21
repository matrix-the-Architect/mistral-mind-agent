import { useCallback, useEffect, useRef, useState } from "react";

import { remoteApi } from "./api";
import type { InferenceResult, NamespaceStatus, RelayConfig, RemoteApi } from "./api";
import { buildAnalyzeMessages, buildRecallMessages } from "./outbound";
import { REDACTOR_LABEL } from "./redactor";
import { creationProvenance, originDisplay, receiptsForMemory } from "./trail";
import type { UsageReceipt } from "./trail";
import { DEMO_STEPS, buildEvidence, buildSampleBrief, demoProgress, demoStepDone } from "./demo";
import type { DemoProgressInput, EvidenceSection } from "./demo";
import {
  composeFollowUp,
  discardStreamIfStale,
  displayCaptureSupported,
  drawVideoFrame,
  isCaptureCurrent,
  pickDisplayStream,
  releaseCanvas,
  releaseVideo,
  stopStream,
  waitForVideoReady,
} from "./capture";
import { createOcrController, recognizeGuarded } from "./ocr";
import type { OcrController } from "./ocr";
import { localVoiceAvailable, speakLocal, stopSpeech, waitForLocalVoices } from "./speech";
import { openControlStore } from "./control";
import type { CapabilityRecord, ControlStore, ForgetRecord, RelaySessionRecord } from "./control";
import {
  FORGET_CHANNEL,
  assertPairActive,
  bootstrapGhost,
  broadcastForgetting,
  forgetVault,
  retryAllPendingForgetting,
  retryRemoteForgetting,
  startNewSession,
} from "./forget";
import type { ForgetBroadcast, VaultPair } from "./forget";
import { openVaultStore } from "./idb";
import type { VaultStore } from "./store";
import {
  RECALL_LIMIT,
  countArtifacts,
  inspectVaultReadOnly,
  listEnvelopes,
  loadAllMemories,
  recallMemories,
  saveMemory,
} from "./vault";
import type { LocalInspection } from "./vault";
import type { DecryptedMemory, OutboundMessage } from "./types";
import type { Vault } from "./vault";

/** The fictional demonstration brief, prefilled so the flow can be run with one paste. */
const DEMO_BRIEF =
  "Project Cedar is an event check-in kiosk. It must work during internet outages and must not collect visitor email addresses. The current proposal requires visitors to enter an email address and authenticate using an online OAuth provider. Identify the conflicts and suggest a revised flow.";

type Status = { kind: "idle" } | { kind: "loading"; label: string } | { kind: "success"; label: string } | { kind: "error"; label: string };

const idle: Status = { kind: "idle" };

/** Per-artifact remote state: saved locally vs. acknowledged by the relay vs. awaiting upload. */
type UploadState = "uploading" | "uploaded" | "awaiting";

type VaultState =
  | { status: "loading" }
  | { status: "ready"; vault: Vault; session: RelaySessionRecord; capability: CapabilityRecord }
  | { status: "key-unavailable" }
  | { status: "forgotten"; record: ForgetRecord }
  | { status: "error"; message: string };

interface Preview {
  messages: OutboundMessage[];
  memoryIds: string[];
  question: string;
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "idle") {
    return null;
  }
  return <p className={`status status-${status.kind}`}>{status.kind === "loading" ? `… ${status.label}` : status.label}</p>;
}

/** The factual Forget Me status panel: separate local/remote outcomes, no blanket "all deleted". */
function ForgetPanel({
  record,
  onRetry,
  onStartNewSession,
  retrying,
}: {
  record: ForgetRecord;
  onRetry: () => void;
  onStartNewSession: () => void;
  retrying: boolean;
}) {
  const remoteDone = record.remote === "completed";
  return (
    <section className="panel forget-panel">
      <h2>Forget Me — status</h2>
      <ul className="forget-list">
        <li>Browser key record removed: <strong>{record.localKeyRemoved ? "yes" : "no"}</strong></li>
        <li>Local memory records removed: <strong>{record.localRecordsRemoved}</strong></li>
        <li>
          Server namespace revoked:{" "}
          <strong>{remoteDone && record.revokedAt ? `yes (at ${record.revokedAt})` : remoteDone ? "yes" : "not yet"}</strong>
        </li>
        <li>
          Server memory records removed:{" "}
          <strong>{record.artifactsRemoved === null ? "not yet" : record.artifactsRemoved}</strong>
        </li>
        <li>
          Remote cleanup:{" "}
          <strong className={remoteDone ? "status-success" : "status-error"}>
            {record.remote === "completed" ? "completed" : record.remote === "failed" ? `failed/pending — ${record.lastError ?? "unknown error"}` : "pending"}
          </strong>
          {record.remote !== "completed" && (
            <button type="button" className="secondary" onClick={onRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry remote deletion"}
            </button>
          )}
        </li>
        <li>
          Minimal erasure/control metadata retained (namespace ID, counts, timestamps, idempotency key) — locally in the control store and
          server-side as the scoped erasure record: <strong>yes, by design</strong>
        </li>
        <li>Mistral-side erasure: <strong>not integrated</strong> — no provider deletion request is made or implied.</li>
      </ul>
      <div className="row">
        <button type="button" className="danger" onClick={onStartNewSession}>
          Start new session
        </button>
      </div>
      <p className="note">
        The old vault (namespace {record.namespaceId.slice(0, 8)}…, generation {record.generation}) is blocked in this and every other open tab. A
        new session gets a fresh namespace and key; forgotten content is never re-encrypted into it.
      </p>
    </section>
  );
}

/** Label shown on request receipts whose question included reviewed screen-extracted text. */
const OCR_INPUT_LABEL = "Text extracted locally from your screen";

/** Milestone 5 guided walkthrough. Completion is derived from real operation results (demoStepDone). */
function DemoGuide({
  input,
  codeword,
  onCodewordChange,
  onLoadBrief,
  demoError,
  onOpenProposal,
  onAnalyze,
  analyzing,
  onCapture,
  captureBusy,
  onRecall,
  onSend,
  canSend,
  recallLoading,
  onForgetArm,
  blocked,
}: {
  input: DemoProgressInput;
  codeword: string;
  onCodewordChange: (value: string) => void;
  onLoadBrief: () => void;
  demoError: string | null;
  onOpenProposal: () => void;
  onAnalyze: () => void;
  analyzing: boolean;
  onCapture: () => void;
  captureBusy: boolean;
  onRecall: () => void;
  onSend: () => void;
  canSend: boolean;
  recallLoading: boolean;
  onForgetArm: () => void;
  blocked: boolean;
}) {
  const progress = demoProgress(input);
  return (
    <section className="panel demo-guide">
      <h2>Guided demonstration</h2>
      <p className="note">
        {progress.done}/{progress.total} steps complete — completion follows real operation results, not a script. Every action uses the
        same approval and authorization checks as normal mode.
      </p>
      <ol className="demo-steps">
        {DEMO_STEPS.map((step, index) => {
          const done = demoStepDone(step.id, input);
          return (
            <li key={step.id} className={done ? "done" : ""}>
              <strong>
                {index + 1}. {step.title} {done ? "✓" : ""}
              </strong>
              <p className="note">{step.hint}</p>
              {step.id === "load-brief" && (
                <div className="row">
                  <input
                    aria-label="Judge's codeword"
                    type="text"
                    value={codeword}
                    onChange={(event) => onCodewordChange(event.target.value)}
                    placeholder="Judge's codeword…"
                    disabled={blocked}
                  />
                  <button type="button" onClick={onLoadBrief} disabled={blocked || !codeword.trim()}>
                    Load brief into context
                  </button>
                </div>
              )}
              {step.id === "analyze-save" && (
                <div className="row">
                  <button type="button" onClick={onAnalyze} disabled={analyzing || blocked}>
                    Run Analyze
                  </button>
                  <span className="note">then review the answer and explicitly Save memory in section 2</span>
                </div>
              )}
              {step.id === "open-proposal" && (
                <div className="row">
                  <button type="button" className="secondary" onClick={onOpenProposal} disabled={blocked}>
                    Open sample proposal (new tab)
                  </button>
                </div>
              )}
              {step.id === "capture-review" && (
                <div className="row">
                  <button type="button" onClick={onCapture} disabled={captureBusy || blocked}>
                    Capture screen context
                  </button>
                  <span className="note">then review the extracted text and choose “Use in follow-up”</span>
                </div>
              )}
              {step.id === "recall-send" && (
                <div className="row">
                  <button type="button" onClick={onRecall} disabled={recallLoading || blocked}>
                    Recall memory
                  </button>
                  <button type="button" onClick={onSend} disabled={!canSend || recallLoading || blocked}>
                    Send approved request
                  </button>
                </div>
              )}
              {step.id === "inspect-trail" && <p className="note">Open the Memory trail panel below — artifact IDs, origins, upload acknowledgments, request receipts.</p>}
              {step.id === "forget" && (
                <div className="row">
                  <button type="button" className="danger" onClick={onForgetArm} disabled={blocked}>
                    Forget Me…
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {demoError && <p className="note error-text">{demoError}</p>}
    </section>
  );
}

/** Milestone 5 technical evidence panel: every item names its source and observation time. */
function EvidencePanel({
  sections,
  onInspectLocal,
  onFetchServer,
  inspecting,
  fetching,
  canFetch,
}: {
  sections: EvidenceSection[];
  onInspectLocal: () => void;
  onFetchServer: () => void;
  inspecting: boolean;
  fetching: boolean;
  canFetch: boolean;
}) {
  return (
    <section className="panel evidence-panel">
      <h2>Technical evidence</h2>
      <p className="note">
        Observations from this browser, actual authenticated relay responses, and read-only local inspection. The memory store holds
        ciphertext only; the inference relay handles approved text in transit. No claim is made beyond what was actually observed —
        physical erasure from every storage layer and Mistral-side deletion are NOT claimed.
      </p>
      <div className="row">
        <button type="button" className="secondary" onClick={onInspectLocal} disabled={inspecting}>
          {inspecting ? "Inspecting…" : "Inspect local vault (read-only)"}
        </button>
        <button type="button" className="secondary" onClick={onFetchServer} disabled={fetching || !canFetch}>
          {fetching ? "Fetching…" : "Fetch server status"}
        </button>
      </div>
      {sections.map((section) => (
        <div key={section.title}>
          <h3>{section.title}</h3>
          <ul className="evidence-list">
            {section.items.map((item, index) => (
              <li key={index}>
                <strong>{item.label}:</strong> {item.value}
                <p className="note">
                  source: {item.source}
                  {item.at ? ` · observed ${item.at}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function GhostPage() {
  // --- all component state (declared before any callback that references it) ---
  const [vaultState, setVaultState] = useState<VaultState>({ status: "loading" });
  const [relayStatus, setRelayStatus] = useState<Status>(idle);
  const [forgetRecord, setForgetRecord] = useState<ForgetRecord | null>(null);
  const [forgetStatus, setForgetStatus] = useState<Status>(idle);
  const [retrying, setRetrying] = useState(false);

  const [contextText, setContextText] = useState(DEMO_BRIEF);
  const [analyzeStatus, setAnalyzeStatus] = useState<Status>(idle);
  const [answer, setAnswer] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<OutboundMessage[] | null>(null);

  const [memoryText, setMemoryText] = useState("");
  const [memorySource, setMemorySource] = useState("manual");
  const [saveStatus, setSaveStatus] = useState<Status>(idle);

  const [question, setQuestion] = useState("");
  const [recallStatus, setRecallStatus] = useState<Status>(idle);
  const [recalled, setRecalled] = useState<DecryptedMemory[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [recallAnswer, setRecallAnswer] = useState<{ text: string; memoryIds: string[] } | null>(null);

  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const [panelMemories, setPanelMemories] = useState<DecryptedMemory[]>([]);
  const [uploadStates, setUploadStates] = useState<Record<string, UploadState>>({});
  const [pullStatus, setPullStatus] = useState<Status>(idle);

  // --- milestone 3: transient usage receipts ("this conversation" only, never persisted) ---
  const [usage, setUsage] = useState<UsageReceipt[]>([]);
  // Two-step Forget Me: the first click only arms the confirmation.
  const [confirmingForget, setConfirmingForget] = useState(false);
  // The Analyze run that seeded the memory field, used to record saved-from-analysis provenance.
  const seededRef = useRef<{ analysisId: string; text: string } | null>(null);

  // --- milestone 4: single-capture screen context + local OCR lifecycle ---
  type CaptureStatus =
    | { kind: "idle" }
    | { kind: "picking"; operationId: string }
    | { kind: "capturing"; operationId: string }
    | { kind: "ocr"; operationId: string; progress: number }
    | { kind: "review"; operationId: string; text: string }
    | { kind: "error"; message: string };
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>({ kind: "idle" });
  const [ocrDraft, setOcrDraft] = useState("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const captureOpRef = useRef<string | null>(null);
  const captureSessionRef = useRef<{ stream: MediaStream | null; video: HTMLVideoElement | null } | null>(null);
  const ocrRef = useRef<OcrController | null>(null);
  const mountedRef = useRef(true);
  // Set when reviewed OCR text is used in a follow-up, so the request receipt can label its input.
  const usedOcrRef = useRef(false);

  // --- milestone 5: Demo mode (presentation only — the switch itself has NO side effects) ---
  const [demoMode, setDemoMode] = useState(false);
  const [codeword, setCodeword] = useState("");
  const [briefLoaded, setBriefLoaded] = useState(false);
  const [proposalOpened, setProposalOpened] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [relayConfig, setRelayConfig] = useState<RelayConfig | null>(null);
  const [localInspection, setLocalInspection] = useState<LocalInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [serverStatus, setServerStatus] = useState<
    { status: NamespaceStatus; fetchedAt: string } | { error: string; fetchedAt: string } | null
  >(null);
  const [fetchingStatus, setFetchingStatus] = useState(false);
  // Local read-aloud (milestone 5 optional): which answer is being spoken; null = not speaking.
  const [speakingFor, setSpeakingFor] = useState<"answer" | "recall" | null>(null);
  const [speechNote, setSpeechNote] = useState<string | null>(null);

  // --- vault + control plane (browser-only: IndexedDB exists only in the browser, never during SSR) ---
  const storeRef = useRef<VaultStore | null>(null);
  const controlRef = useRef<ControlStore | null>(null);
  const vaultRef = useRef<VaultState>({ status: "loading" });
  vaultRef.current = vaultState;
  // Set synchronously on Forget Me: blocks new inference/recall/saves/uploads immediately.
  const forgettingRef = useRef(false);
  // Outstanding request controllers, aborted on Forget Me where possible.
  const controllersRef = useRef<Set<AbortController>>(new Set());
  const apiRef = useRef<RemoteApi>(remoteApi);

  const newSignal = useCallback((): AbortSignal => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return controller.signal;
  }, []);

  const releaseSignal = useCallback((signal: AbortSignal): void => {
    for (const controller of controllersRef.current) {
      if (controller.signal === signal) controllersRef.current.delete(controller);
    }
  }, []);

  const abortAll = useCallback((): void => {
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
  }, []);

  const deps = useCallback((): { vaultStore: VaultStore; control: ControlStore; api: RemoteApi } => {
    const vaultStore = storeRef.current;
    const control = controlRef.current;
    if (!vaultStore || !control) throw new Error("Stores not initialized yet.");
    return { vaultStore, control, api: apiRef.current };
  }, []);

  // --- startup: respect a persisted forgetting state before any vault init; otherwise bootstrap ---

  const refreshPanel = useCallback(async () => {
    const store = storeRef.current;
    const current = vaultRef.current;
    if (!store || current.status !== "ready") {
      return;
    }
    const count = await countArtifacts(store);
    setMemoryCount(count);
    if (count > 0) {
      setPanelMemories(await loadAllMemories(store, current.vault));
    } else {
      setPanelMemories([]);
    }
    // Remote acknowledgment per artifact: "uploaded" only once the relay has accepted it.
    try {
      const remote = await apiRef.current.listArtifacts(current.session.token, current.vault.namespaceId, newSignal());
      const remoteIds = new Set(remote.map((envelope) => envelope.artifactId));
      const local = await listEnvelopes(store);
      const states: Record<string, UploadState> = {};
      for (const envelope of local) {
        states[envelope.artifactId] = remoteIds.has(envelope.artifactId) ? "uploaded" : "awaiting";
      }
      setUploadStates(states);
    } catch {
      // Remote listing unavailable (offline): states stay as they are; nothing is claimed uploaded.
    }
  }, [newSignal]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const control = await openControlStore();
      const store = await openVaultStore();
      if (cancelled) return;
      controlRef.current = control;
      storeRef.current = store;
      const boot = await bootstrapGhost({ vaultStore: store, control, api: apiRef.current });
      if (cancelled) return;
      if (boot.kind === "forgotten") {
        // Persisted forgetting/forgotten state: never silently reconstruct the old vault.
        forgettingRef.current = true;
        setForgetRecord(boot.record);
        setVaultState({ status: "forgotten", record: boot.record });
        setForgetStatus({
          kind: "success",
          label: boot.record.remote === "completed" ? "Forgotten (local + remote cleanup completed)." : "Forgotten locally; remote cleanup pending.",
        });
        // Retry any unfinished remote cleanup in the background (this is not an upload or recall).
        void retryAllPendingForgetting({ vaultStore: store, control, api: apiRef.current }).then((records) => {
          if (cancelled || records.length === 0) return;
          const active = records.find((record) => record.namespaceId === boot.record.namespaceId) ?? records[0];
          if (!active) return;
          setForgetRecord(active);
          setVaultState((current) => (current.status === "forgotten" ? { status: "forgotten", record: active } : current));
        });
        return;
      }
      if (boot.kind === "ready") {
        setVaultState({ status: "ready", vault: boot.vault, session: boot.session, capability: boot.capability });
        setRelayStatus({ kind: "loading", label: "Checking relay configuration…" });
        apiRef.current
          .getConfig(boot.session.token)
          .then((config: RelayConfig) => {
            if (cancelled) return;
            setRelayConfig(config);
            setRelayStatus(
              config.configured
                ? { kind: "success", label: `Relay ready: model ${config.model} @ ${config.provider_origin} (model available: ${config.model_available === null ? "unknown" : config.model_available ? "yes" : "NO — configuration problem"})` }
                : { kind: "error", label: "Relay has no MISTRAL_API_KEY configured; inference will fail with 503 until it is set." }
            );
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setRelayStatus({ kind: "error", label: `Relay unreachable: ${error instanceof Error ? error.message : String(error)}` });
          });
        void refreshPanel().catch(() => setPanelMemories([]));
        return;
      }
      if (boot.kind === "key-unavailable") {
        setVaultState({ status: "key-unavailable" });
      } else {
        setVaultState({ status: "error", message: boot.message });
      }
    })();
    // Other tabs: when one forgets this vault, stop using it here too.
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(FORGET_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const message = event.data as ForgetBroadcast;
        const current = vaultRef.current;
        if (
          message?.type === "forgetting" &&
          current.status === "ready" &&
          message.namespaceId === current.vault.namespaceId &&
          message.generation === current.vault.generation
        ) {
          forgettingRef.current = true;
          abortAll();
          const record: ForgetRecord = {
            namespaceId: message.namespaceId,
            generation: message.generation,
            deletionToken: current.capability.deletionToken,
            idempotencyKey: current.capability.idempotencyKey,
            state: "forgotten",
            remote: "pending",
            localKeyRemoved: false,
            localRecordsRemoved: 0,
            artifactsRemoved: null,
            revokedAt: null,
            attempts: 0,
            lastError: "Forgotten from another tab; local wipe happens there.",
            createdAt: message.at,
            updatedAt: message.at,
          };
          setForgetRecord(record);
          setVaultState({ status: "forgotten", record });
          setPreview(null);
          setRecalled(null);
          setAnswer(null);
          setRecallAnswer(null);
          setLastSent(null);
          // Cross-tab forgetting also clears demo-held content; nothing is reseeded afterwards.
          setBriefLoaded(false);
          setProposalOpened(false);
          setCodeword("");
          setLocalInspection(null);
          setServerStatus(null);
          stopSpeech();
          setSpeakingFor(null);
        }
      };
    }
    return () => {
      cancelled = true;
      channel?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // --- vault pair capture + guard ---
  /** The active pair, or null once the vault is forgetting/forgotten/unavailable. */
  const activePair = (): VaultPair | null => {
    const current = vaultRef.current;
    return current.status === "ready" && !forgettingRef.current
      ? { namespaceId: current.vault.namespaceId, generation: current.vault.generation }
      : null;
  };

  const capturePair = (): VaultPair | null => activePair();

  const requireVault = (): { vault: Vault; session: RelaySessionRecord } => {
    const current = vaultRef.current;
    if (forgettingRef.current || current.status !== "ready") {
      throw new Error(
        forgettingRef.current
          ? "This vault is being forgotten; the operation was blocked."
          : current.status === "key-unavailable"
            ? "Memory key unavailable."
            : "The memory vault is not ready yet."
      );
    }
    return { vault: current.vault, session: current.session };
  };

  const discardIfForgetting = (): boolean => forgettingRef.current;

  // --- actions ---

  const handleAnalyze = async () => {
    const store = storeRef.current;
    if (!store) return;
    const pair = capturePair();
    if (!pair) {
      setAnalyzeStatus({ kind: "error", label: "Memory vault is not ready or is being forgotten; cannot tag the request with its namespace." });
      return;
    }
    if (!contextText.trim()) {
      setAnalyzeStatus({ kind: "error", label: "Paste a brief or problem first." });
      return;
    }
    let { session } = requireVault();
    const signal = newSignal();
    // A fresh app-generated ID for this analysis (a Ghost ID, not a provider request ID), and one
    // for this conversation's request receipt.
    const analysisId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const wasEmpty = !memoryText.trim();
    setAnalyzeStatus({ kind: "loading", label: "Calling Mistral through the relay…" });
    setAnswer(null);
    // The exact outbound snapshot, built fresh and shown in the preview area.
    const messages = buildAnalyzeMessages(contextText);
    setLastSent(messages);
    setUsage((current) => [
      ...current,
      { requestId, status: "pending", memoryIds: [], snapshot: messages, at: new Date().toISOString() },
    ]);
    try {
      const result: InferenceResult = await apiRef.current.postInference(session.token, {
        messages,
        namespaceId: pair.namespaceId,
        generation: pair.generation,
      }, signal);
      releaseSignal(signal);
      // Discard late results after a vault change (e.g. Forget Me): never display or save them.
      assertPairActive(activePair(), pair);
      setAnswer(result.text);
      setUsage((current) =>
        current.map((receipt) =>
          receipt.requestId === requestId
            ? { ...receipt, status: "answered", answerText: result.text, completedAt: new Date().toISOString() }
            : receipt
        )
      );
      setAnalyzeStatus({ kind: "success", label: `Answer received from ${result.model} (namespace ${result.namespace_id.slice(0, 8)}…, generation ${result.generation}).` });
      // Seed the editable memory field from the useful answer; the user controls what is saved.
      seededRef.current = wasEmpty ? { analysisId, text: result.text } : null;
      setMemoryText((current) => (current.trim() ? current : result.text));
      setMemorySource((current) => (current === "manual" ? `mistral-answer (${result.model})` : current));
    } catch (error) {
      releaseSignal(signal);
      if (discardIfForgetting()) return; // aborted/discarded by Forget Me
      const message = error instanceof Error ? error.message : String(error);
      setUsage((current) =>
        current.map((receipt) =>
          receipt.requestId === requestId
            ? { ...receipt, status: "failed", error: message, completedAt: new Date().toISOString() }
            : receipt
        )
      );
      setAnalyzeStatus({ kind: "error", label: message });
    }
  };

  const handleSaveMemory = async () => {
    const store = storeRef.current;
    if (!store) return;
    const pair = capturePair();
    if (!pair) {
      setSaveStatus({ kind: "error", label: "Memory vault is not ready or is being forgotten." });
      return;
    }
    if (!memoryText.trim()) {
      setSaveStatus({ kind: "error", label: "The memory text is empty; nothing to save." });
      return;
    }
    const { vault, session } = requireVault();
    setSaveStatus({ kind: "loading", label: "Encrypting and saving locally…" });
    try {
      // Milestone-3 creation provenance: only the four new fields, encrypted with the memory.
      // Absent from older records, which therefore show "Origin not recorded." — nothing migrated.
      const creation = creationProvenance({ seeded: seededRef.current, memoryText });
      const envelope = await saveMemory(store, vault, memoryText, {
        source: memorySource,
        createdAt: new Date().toISOString(),
        purpose: "user-saved decision from a Ghost conversation",
        ...creation,
      });
      assertPairActive(activePair(), pair);
      setUploadStates((states) => ({ ...states, [envelope.artifactId]: "uploading" }));
      setSaveStatus({ kind: "success", label: `Saved locally, encrypted as artifact ${envelope.artifactId.slice(0, 8)}… (AES-GCM, 12-byte IV, AAD-bound). Uploading ciphertext…` });
      // Upload the ciphertext envelope; "uploaded" is shown only after the relay acknowledges it.
      const signal = newSignal();
      try {
        await apiRef.current.uploadArtifact(session.token, envelope, signal);
        releaseSignal(signal);
        assertPairActive(activePair(), pair);
        setUploadStates((states) => ({ ...states, [envelope.artifactId]: "uploaded" }));
        setSaveStatus({ kind: "success", label: `Saved locally and uploaded (artifact ${envelope.artifactId.slice(0, 8)}… acknowledged by the relay).` });
      } catch (error) {
        releaseSignal(signal);
        if (discardIfForgetting()) return;
        setUploadStates((states) => ({ ...states, [envelope.artifactId]: "awaiting" }));
        setSaveStatus({
          kind: "success",
          label: `Saved locally (artifact ${envelope.artifactId.slice(0, 8)}…); remote upload awaiting retry: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      await refreshPanel();
    } catch (error) {
      if (discardIfForgetting()) return;
      setSaveStatus({ kind: "error", label: error instanceof Error ? error.message : String(error) });
    }
  };

  /** Upload every locally saved artifact the relay has not acknowledged yet. Explicit user action. */
  const handleUploadPending = async () => {
    const store = storeRef.current;
    if (!store) return;
    const pair = capturePair();
    if (!pair) {
      setPullStatus({ kind: "error", label: "Memory vault is not ready or is being forgotten." });
      return;
    }
    const { session } = requireVault();
    setPullStatus({ kind: "loading", label: "Uploading pending artifacts…" });
    try {
      const envelopes = await listEnvelopes(store);
      let uploaded = 0;
      for (const envelope of envelopes) {
        if (uploadStates[envelope.artifactId] === "uploaded") continue;
        const signal = newSignal();
        await apiRef.current.uploadArtifact(session.token, envelope, signal);
        releaseSignal(signal);
        assertPairActive(activePair(), pair);
        setUploadStates((states) => ({ ...states, [envelope.artifactId]: "uploaded" }));
        uploaded += 1;
      }
      setPullStatus({ kind: "success", label: `Uploaded ${uploaded} pending artifact(s).` });
      await refreshPanel();
    } catch (error) {
      if (discardIfForgetting()) return;
      setPullStatus({ kind: "error", label: error instanceof Error ? error.message : String(error) });
    }
  };

  /** Fetch the server's ciphertext copies into the local cache (the key and namespace are retained). */
  const handlePullRemote = async () => {
    const store = storeRef.current;
    if (!store) return;
    const pair = capturePair();
    if (!pair) {
      setPullStatus({ kind: "error", label: "Memory vault is not ready or is being forgotten." });
      return;
    }
    const { session } = requireVault();
    setPullStatus({ kind: "loading", label: "Fetching remote ciphertext…" });
    try {
      const signal = newSignal();
      const remote = await apiRef.current.listArtifacts(session.token, pair.namespaceId, signal);
      releaseSignal(signal);
      assertPairActive(activePair(), pair);
      let added = 0;
      for (const envelope of remote) {
        if (envelope.namespaceId !== pair.namespaceId || envelope.generation !== pair.generation) continue;
        const existing = await store.transact(["artifacts"], "readonly", (tx) => tx.get("artifacts", envelope.artifactId));
        if (existing === undefined) {
          await store.transact(["artifacts"], "readwrite", (tx) => tx.put("artifacts", envelope.artifactId, envelope));
          added += 1;
        }
      }
      assertPairActive(activePair(), pair);
      setPullStatus({
        kind: "success",
        label: `Fetched ${remote.length} remote envelope(s), restored ${added} into the local cache; they decrypt with the retained key on Recall.`,
      });
      await refreshPanel();
    } catch (error) {
      if (discardIfForgetting()) return;
      setPullStatus({ kind: "error", label: error instanceof Error ? error.message : String(error) });
    }
  };

  /** New conversation: clears inputs, answers, usage receipts and transient state. Memories stay. */
  const handleNewConversation = () => {
    setContextText("");
    setQuestion("");
    setAnswer(null);
    setLastSent(null);
    setRecallAnswer(null);
    setRecalled(null);
    setPreview(null);
    setMemoryText("");
    setMemorySource("manual");
    setAnalyzeStatus(idle);
    setSaveStatus(idle);
    setRecallStatus(idle);
    // "This conversation" usage receipts are cleared; saved memories and their encrypted
    // creation provenance are retained.
    setUsage([]);
    seededRef.current = null;
    usedOcrRef.current = false;
    // Demo-helper content follows the same lifecycle as the conversation inputs: cleared, never reseeded.
    setBriefLoaded(false);
    setProposalOpened(false);
    setCodeword("");
    setDemoError(null);
    // A new conversation also tears down any capture/OCR state and stops read-aloud speech.
    cleanupCapture(false);
    stopSpeech();
    setSpeakingFor(null);
    setSpeechNote(null);
  };

  const handleRecall = async () => {
    const store = storeRef.current;
    if (!store) return;
    const pair = capturePair();
    if (!pair) {
      setRecallStatus({ kind: "error", label: "Memory vault is not ready or is being forgotten." });
      return;
    }
    if (!question.trim()) {
      setRecallStatus({ kind: "error", label: "Type a follow-up question first." });
      return;
    }
    setRecallStatus({ kind: "loading", label: "Reading and decrypting local memories…" });
    setRecallAnswer(null);
    try {
      const { vault } = requireVault();
      const selected = await recallMemories(store, vault, RECALL_LIMIT);
      assertPairActive(activePair(), pair);
      setRecalled(selected);
      if (selected.length === 0) {
        setPreview(null);
        setRecallStatus({ kind: "success", label: "No saved memories exist yet — nothing was recalled." });
        return;
      }
      const messages = buildRecallMessages(question, selected);
      setPreview({ messages, memoryIds: selected.map((memory) => memory.artifactId), question });
      setRecallStatus({ kind: "success", label: `Recalled ${selected.length} memory(ies) locally; review the outbound preview, then Send.` });
    } catch (error) {
      if (discardIfForgetting()) return;
      setRecallStatus({ kind: "error", label: error instanceof Error ? error.message : String(error) });
    }
  };

  // Any change to the question invalidates the preview: a new approval (Recall, review, Send) is
  // required before anything goes out. The selected memories change only through Recall, which
  // rebuilds the preview itself.
  useEffect(() => {
    setPreview(null);
  }, [question]);

  const handleSend = async () => {
    if (!preview) return;
    const pair = capturePair();
    if (!pair) {
      setRecallStatus({ kind: "error", label: "Memory vault is not ready or is being forgotten." });
      return;
    }
    const { session } = requireVault();
    const signal = newSignal();
    const requestId = crypto.randomUUID();
    setUsage((current) => [
      ...current,
      {
        requestId,
        status: "pending",
        memoryIds: preview.memoryIds,
        snapshot: preview.messages,
        at: new Date().toISOString(),
        ...(usedOcrRef.current ? { inputLabel: OCR_INPUT_LABEL } : {}),
      },
    ]);
    setRecallStatus({ kind: "loading", label: "Sending the approved snapshot…" });
    try {
      // Send exactly the approved, previewed snapshot.
      const result = await apiRef.current.postInference(session.token, {
        messages: preview.messages,
        namespaceId: pair.namespaceId,
        generation: pair.generation,
      }, signal);
      releaseSignal(signal);
      // A late answer after Forget Me is discarded, never displayed or saved.
      assertPairActive(activePair(), pair);
      setRecallAnswer({ text: result.text, memoryIds: preview.memoryIds });
      setUsage((current) =>
        current.map((receipt) =>
          receipt.requestId === requestId
            ? { ...receipt, status: "answered", answerText: result.text, completedAt: new Date().toISOString() }
            : receipt
        )
      );
      setRecallStatus({ kind: "success", label: `Answer received (namespace ${result.namespace_id.slice(0, 8)}…, generation ${result.generation}).` });
    } catch (error) {
      releaseSignal(signal);
      if (discardIfForgetting()) return;
      const message = error instanceof Error ? error.message : String(error);
      setUsage((current) =>
        current.map((receipt) =>
          receipt.requestId === requestId
            ? { ...receipt, status: "failed", error: message, completedAt: new Date().toISOString() }
            : receipt
        )
      );
      setRecallStatus({ kind: "error", label: message });
    }
  };

  // --- milestone 4: capture screen context (one frame, local OCR only) ---

  /** Stop tracks, detach the video, cancel/terminate OCR, drop the operation. Safe to call anytime. */
  const cleanupCapture = useCallback((resetStatus: boolean = true) => {
    const session = captureSessionRef.current;
    captureSessionRef.current = null;
    stopStream(session?.stream);
    releaseVideo(session?.video);
    const ocr = ocrRef.current;
    ocrRef.current = null;
    if (ocr) void ocr.cancel().catch(() => undefined);
    captureOpRef.current = null;
    if (resetStatus && mountedRef.current) {
      setCaptureStatus({ kind: "idle" });
      setOcrDraft("");
      setCaptureError(null);
    }
  }, []);

  const handleCapture = async () => {
    if (!displayCaptureSupported()) {
      setCaptureStatus({ kind: "error", message: "Screen capture is not supported in this browser (getDisplayMedia is unavailable). Paste text instead." });
      return;
    }
    const pair = capturePair();
    if (!pair) {
      setCaptureStatus({ kind: "error", message: "Memory vault is not ready or is being forgotten." });
      return;
    }
    const operationId = crypto.randomUUID();
    captureOpRef.current = operationId;
    setCaptureError(null);
    setOcrDraft("");
    setCaptureStatus({ kind: "picking", operationId });
    const isCurrent = () =>
      isCaptureCurrent({
        forgetting: forgettingRef.current,
        active: activePair(),
        captured: pair,
        currentOperationId: captureOpRef.current,
        operationId,
        mounted: mountedRef.current,
      });
    let canvas: HTMLCanvasElement | null = null;
    try {
      // Called directly in the click handler so the browser's user activation is intact.
      const stream = await pickDisplayStream();
      // Picker race: if the user forgot/cancelled/started another capture while the browser
      // picker was open, a stream granted now is stopped immediately and discarded.
      if (discardStreamIfStale(stream, isCurrent())) return;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      captureSessionRef.current = { stream, video };
      setCaptureStatus({ kind: "capturing", operationId });
      await video.play().catch(() => undefined);
      await waitForVideoReady(video);
      if (!isCurrent()) return;
      canvas = drawVideoFrame(video);
      // ALL tracks stop immediately after the frame is obtained, before OCR starts.
      stopStream(stream);
      releaseVideo(video);
      captureSessionRef.current = null;
      if (!isCurrent()) return;
      const ocr = createOcrController();
      ocrRef.current = ocr;
      setCaptureStatus({ kind: "ocr", operationId, progress: 0 });
      const text = await recognizeGuarded({
        canvas,
        ocr,
        isCurrent,
        onProgress: (progress) => {
          if (mountedRef.current && isCurrent()) setCaptureStatus({ kind: "ocr", operationId, progress: progress.progress });
        },
      });
      // A late OCR result after Forget Me / cancel / new capture is discarded, never displayed.
      if (!isCurrent()) return;
      const trimmed = (text ?? "").trim();
      if (!trimmed) {
        setCaptureStatus({ kind: "error", message: "No readable text was found in the captured frame. You can paste text instead." });
        return;
      }
      setOcrDraft(trimmed);
      setCaptureStatus({ kind: "review", operationId, text: trimmed });
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/NotAllowedError|permission|denied|abort/i.test(message)) {
        setCaptureStatus({ kind: "error", message: "Screen capture was cancelled or permission was denied. You can paste text instead." });
      } else {
        setCaptureStatus({ kind: "error", message: `Capture or OCR failed: ${message}` });
      }
    } finally {
      const ocr = ocrRef.current;
      ocrRef.current = null;
      if (ocr) void ocr.cancel().catch(() => undefined);
      releaseCanvas(canvas);
    }
  };

  const handleCancelCapture = () => {
    cleanupCapture();
  };

  /** Apply the reviewed/edited extracted text to the existing follow-up question. */
  const handleUseInFollowUp = () => {
    const pair = capturePair();
    if (!pair) {
      setCaptureError("Memory vault is not ready or is being forgotten.");
      return;
    }
    const composed = composeFollowUp(ocrDraft);
    if (!composed.ok) {
      setCaptureError(composed.error);
      return;
    }
    setCaptureError(null);
    usedOcrRef.current = true;
    // Populating the question runs the question-change effect, which invalidates any previously
    // approved outbound preview; clear it explicitly as well.
    setQuestion(composed.question);
    setPreview(null);
    setCaptureStatus({ kind: "idle" });
    setOcrDraft("");
    captureOpRef.current = null;
  };

  const handleDiscardOcr = () => {
    cleanupCapture();
  };

  // --- milestone 5: Demo mode actions (all reuse the normal actions and backend; no mock data) ---

  /** Load the sample brief into the EXISTING context input — explicit action; codeword not retained. */
  const handleLoadBrief = () => {
    const word = codeword.trim();
    if (!word) {
      setDemoError("Enter the judge's codeword first — it is woven into the example brief.");
      return;
    }
    setDemoError(null);
    setContextText(buildSampleBrief(word));
    setBriefLoaded(true);
    // No hidden plaintext copy of the codeword stays in demo state; the brief is ordinary context
    // and is cleared by New conversation / Forget Me like any other input. Never reseeded.
    setCodeword("");
  };

  /** Open the labeled synthetic proposal page — always a user action, in a new tab. */
  const handleOpenProposal = () => {
    window.open("/demo/sample-proposal", "_blank", "noopener,noreferrer");
    setProposalOpened(true);
  };

  /** Read-only local inspection: gets/counts only — cannot create a key or reconstruct a vault. */
  const handleInspectLocal = async () => {
    const store = storeRef.current;
    if (!store) return;
    setInspecting(true);
    try {
      setLocalInspection(await inspectVaultReadOnly(store));
    } catch (error) {
      setDemoError(error instanceof Error ? error.message : String(error));
    } finally {
      setInspecting(false);
    }
  };

  /** Read a completed answer aloud with a LOCAL voice only; the start is re-guarded. */
  const handleReadAloud = async (text: string, which: "answer" | "recall") => {
    const pair = capturePair();
    if (!pair) {
      setSpeechNote("The vault is not active, so nothing is read aloud.");
      return;
    }
    stopSpeech();
    setSpeakingFor(null);
    setSpeechNote(null);
    // Voices may load asynchronously; the pair is re-checked after the wait and again at start.
    await waitForLocalVoices();
    const isCurrent = () => {
      const active = activePair();
      return (
        mountedRef.current &&
        !forgettingRef.current &&
        active !== null &&
        active.namespaceId === pair.namespaceId &&
        active.generation === pair.generation
      );
    };
    if (!isCurrent()) return;
    if (!localVoiceAvailable()) {
      setSpeechNote("Local speech is unavailable in this browser (no local voice); no remote voice is used.");
      return;
    }
    const started = speakLocal(text, { isCurrent });
    if (started) {
      setSpeakingFor(which);
    } else if (isCurrent()) {
      setSpeechNote("Speech did not start (guard rejected it or no local voice).");
    }
  };

  const handleStopSpeech = () => {
    stopSpeech();
    setSpeakingFor(null);
  };

  /** Fetch the owner-scoped server status (lifecycle + real artifact count) via the session token. */
  const handleFetchServerStatus = async () => {
    const current = vaultRef.current;
    if (current.status !== "ready" || forgettingRef.current) {
      setServerStatus({ error: "vault is not active", fetchedAt: new Date().toISOString() });
      return;
    }
    const signal = newSignal();
    setFetchingStatus(true);
    try {
      const status = await apiRef.current.getNamespaceStatus(current.session.token, current.vault.namespaceId, signal);
      setServerStatus({ status, fetchedAt: new Date().toISOString() });
    } catch (error) {
      setServerStatus({ error: error instanceof Error ? error.message : String(error), fetchedAt: new Date().toISOString() });
    } finally {
      releaseSignal(signal);
      setFetchingStatus(false);
    }
  };

  // Unmount: stop tracks, terminate OCR, mark unmounted so no late callback applies state.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = captureSessionRef.current;
      captureSessionRef.current = null;
      stopStream(session?.stream);
      releaseVideo(session?.video);
      const ocr = ocrRef.current;
      ocrRef.current = null;
      if (ocr) void ocr.cancel().catch(() => undefined);
      captureOpRef.current = null;
      stopSpeech();
    };
  }, []);

  // --- Forget Me ---

  const handleForget = async () => {
    const current = vaultRef.current;
    if (current.status !== "ready" || forgettingRef.current) return;
    setConfirmingForget(false);
    const pair: VaultPair = { namespaceId: current.vault.namespaceId, generation: current.vault.generation };
    // 1. Immediately block new inference, recall, saves and uploads; abort outstanding requests.
    forgettingRef.current = true;
    abortAll();
    // Stop any in-flight capture/OCR and discard its pending results.
    cleanupCapture(false);
    // Stop current and queued speech; a late start is also blocked by the pair guard.
    stopSpeech();
    setSpeakingFor(null);
    setSpeechNote(null);
    // Invalidate pending previews/results, decrypted memory cards and conversation usage receipts.
    setPreview(null);
    setRecalled(null);
    setAnswer(null);
    setRecallAnswer(null);
    setLastSent(null);
    setUsage([]);
    setPanelMemories([]);
    setMemoryCount(0);
    // Forget Me also clears demo-held content and pre-forget observations; only the permitted
    // erasure result and non-content completion status remain.
    setBriefLoaded(false);
    setProposalOpened(false);
    setCodeword("");
    setDemoError(null);
    setLocalInspection(null);
    setServerStatus(null);
    setForgetStatus({ kind: "loading", label: "Forgetting: persisting retry info, wiping local vault…" });
    try {
      const outcome = await forgetVault(deps(), pair);
      setForgetRecord(outcome.record);
      setVaultState({ status: "forgotten", record: outcome.record });
      broadcastForgetting({ type: "forgetting", namespaceId: pair.namespaceId, generation: pair.generation, at: new Date().toISOString() });
      setForgetStatus({ kind: "success", label: "Local memory removed (key, artifacts, metadata). Remote erasure requested — not waiting on the network." });
      // 4/5. Remote outcome is reported separately when it arrives.
      void outcome.remote.then((record) => {
        setForgetRecord(record);
        setVaultState((state) => (state.status === "forgotten" ? { status: "forgotten", record } : state));
        setForgetStatus(
          record.remote === "completed"
            ? { kind: "success", label: `Remote deletion completed: namespace revoked, ${record.artifactsRemoved ?? 0} server record(s) removed.` }
            : { kind: "error", label: `Remote deletion pending/failed (${record.lastError ?? "unknown"}); use Retry.` }
        );
      });
    } catch (error) {
      setForgetStatus({ kind: "error", label: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleRetryForget = async () => {
    setRetrying(true);
    try {
      const record = await retryRemoteForgetting(deps());
      if (record) {
        setForgetRecord(record);
        setVaultState((state) => (state.status === "forgotten" ? { status: "forgotten", record } : state));
        setForgetStatus(
          record.remote === "completed"
            ? { kind: "success", label: "Remote deletion completed on retry." }
            : { kind: "error", label: `Remote deletion still pending/failed: ${record.lastError ?? "unknown error"}` }
        );
      }
    } finally {
      setRetrying(false);
    }
  };

  const handleStartNewSession = async () => {
    setForgetStatus({ kind: "loading", label: "Starting a new session (new namespace + new key)…" });
    try {
      const result = await startNewSession(deps());
      const boot = result.bootstrap;
      if (boot.kind === "ready") {
        forgettingRef.current = false;
        setVaultState({ status: "ready", vault: boot.vault, session: boot.session, capability: boot.capability });
        setForgetRecord(null);
        setForgetStatus(idle);
        setMemoryCount(null);
        setPanelMemories([]);
        setUploadStates({});
        handleNewConversation();
        void refreshPanel().catch(() => setPanelMemories([]));
        setRelayStatus({ kind: "loading", label: "Checking relay configuration…" });
        apiRef.current
          .getConfig(boot.session.token)
          .then((config: RelayConfig) => {
            setRelayConfig(config);
            setRelayStatus(
              config.configured
                ? { kind: "success", label: `Relay ready: model ${config.model} @ ${config.provider_origin} (model available: ${config.model_available === null ? "unknown" : config.model_available ? "yes" : "NO — configuration problem"})` }
                : { kind: "error", label: "Relay has no MISTRAL_API_KEY configured; inference will fail with 503 until it is set." }
            );
          })
          .catch((error: unknown) => {
            setRelayStatus({ kind: "error", label: `Relay unreachable: ${error instanceof Error ? error.message : String(error)}` });
          });
      } else if (boot.kind === "forgotten") {
        setForgetStatus({ kind: "error", label: "A forgetting state is still active; finish remote cleanup or wait for the retry." });
      } else {
        setForgetStatus({ kind: "error", label: boot.kind === "key-unavailable" ? "Memory key unavailable." : boot.message });
      }
    } catch (error) {
      setForgetStatus({ kind: "error", label: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    document.title = "Mistral Mind";
  }, []);

  const vault = vaultState.status === "ready" ? vaultState.vault : null;
  const keyUnavailable = vaultState.status === "key-unavailable";
  const forgotten = vaultState.status === "forgotten";
  const blocked = forgettingRef.current || forgotten;

  // --- milestone 5 derived demo state (from real results only) ---
  const progressInput: DemoProgressInput = {
    briefLoaded,
    analyzeAnswered: answer !== null,
    memorySaved: saveStatus.kind === "success",
    proposalOpened,
    captureReviewed: captureStatus.kind === "review",
    requestAnswered: usage.some((receipt) => receipt.status === "answered"),
    trailPopulated: panelMemories.length > 0 && usage.length > 0,
    forgotten,
  };
  const evidenceSections: EvidenceSection[] = buildEvidence({
    vault: vault ? { namespaceId: vault.namespaceId, generation: vault.generation } : null,
    vaultState: vaultState.status,
    localInspection,
    relayConfig,
    usage,
    captureStage:
      captureStatus.kind === "idle"
        ? "idle"
        : captureStatus.kind === "ocr"
          ? `OCR running locally (${Math.round(captureStatus.progress * 100)}%)`
          : captureStatus.kind === "review"
            ? "reviewing extracted text"
            : captureStatus.kind,
    serverStatus,
    forgetRecord,
    now: new Date().toISOString(),
  });

  return (
    <main className="ghost">
      <header className="ghost-header">
        <h1>Mistral Mind</h1>
        <p className="tagline">Mistral-powered work companion with browser-encrypted memory, stored as ciphertext locally and on the relay.</p>
        <p className="vault-line">
          Vault:{" "}
          {vault ? (
            <code>
              namespace {vault.namespaceId.slice(0, 8)}… · generation {vault.generation} · AES-GCM 256 key held non-extractable in IndexedDB
            </code>
          ) : keyUnavailable ? (
            <strong className="error-text">Memory key unavailable.</strong>
          ) : forgotten ? (
            <code>forgotten (namespace {vaultState.record.namespaceId.slice(0, 8)}…, generation {vaultState.record.generation})</code>
          ) : vaultState.status === "error" ? (
            <span className="error-text">vault error: {vaultState.message}</span>
          ) : (
            "initializing…"
          )}
        </p>
        <StatusLine status={relayStatus} />
        <label className="demo-toggle">
          <input
            type="checkbox"
            checked={demoMode}
            onChange={(event) => setDemoMode(event.target.checked)}
          />
          <span>
            <strong>Demo mode</strong> — guided walkthrough + technical evidence panel. Presentation only: toggling this sends no
            request, saves no memory, erases nothing, and changes no authentication.
          </span>
        </label>
        {vault && !confirmingForget && (
          <div className="row">
            <button type="button" className="danger" onClick={() => setConfirmingForget(true)} disabled={blocked}>
              Forget Me
            </button>
          </div>
        )}
        {vault && confirmingForget && !blocked && (
          <div className="banner">
            <p>
              <strong>Are you sure?</strong> Forget Me removes the browser key and every local memory record, and asks the relay to
              revoke this namespace and delete its stored ciphertext (retryable if offline). This cannot be undone. You do{" "}
              <strong>not</strong> have to start a new session afterwards — you can stay on this screen.
            </p>
            <div className="row">
              <button type="button" className="danger" onClick={handleForget}>
                Yes, forget everything
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmingForget(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <StatusLine status={forgetStatus} />
        {speechNote && <p className="note error-text">{speechNote}</p>}
      </header>

      {keyUnavailable && (
        <p className="banner error-text">
          Memory key unavailable. Encrypted records exist but the AES-GCM key is missing from IndexedDB; Ghost will not generate a replacement,
          overwrite the records, or fall back to plaintext.
        </p>
      )}

      {forgotten && forgetRecord && (
        <ForgetPanel record={forgetRecord} onRetry={handleRetryForget} onStartNewSession={handleStartNewSession} retrying={retrying} />
      )}

      {demoMode && (
        <DemoGuide
          input={progressInput}
          codeword={codeword}
          onCodewordChange={setCodeword}
          onLoadBrief={handleLoadBrief}
          demoError={demoError}
          onOpenProposal={handleOpenProposal}
          onAnalyze={handleAnalyze}
          analyzing={analyzeStatus.kind === "loading"}
          onCapture={handleCapture}
          captureBusy={captureStatus.kind === "picking" || captureStatus.kind === "capturing" || captureStatus.kind === "ocr"}
          onRecall={handleRecall}
          onSend={handleSend}
          canSend={preview !== null}
          recallLoading={recallStatus.kind === "loading"}
          onForgetArm={() => setConfirmingForget(true)}
          blocked={blocked}
        />
      )}

      {!forgotten && (
        <>
      <section className="panel">
        <h2>1 · Context</h2>
        <textarea
          aria-label="Context"
          rows={6}
          value={contextText}
          onChange={(event) => setContextText(event.target.value)}
          placeholder="Paste a project brief or developer problem…"
          disabled={blocked}
        />
        <div className="row">
          <button type="button" onClick={handleAnalyze} disabled={analyzeStatus.kind === "loading" || blocked}>
            Analyze
          </button>
          <button type="button" className="secondary" onClick={handleNewConversation} disabled={blocked}>
            New conversation
          </button>
        </div>
        <StatusLine status={analyzeStatus} />
        {lastSent && (
          <details className="preview" open>
            <summary>Outbound request sent to the relay (exact messages array)</summary>
            <pre>{JSON.stringify({ messages: lastSent }, null, 2)}</pre>
            <p className="note">{REDACTOR_LABEL}</p>
          </details>
        )}
        {answer !== null && (
          <div className="answer">
            <h3>Mistral answer</h3>
            {/* Plain text only: React escapes this; returned HTML/code is never executed. */}
            <pre>{answer}</pre>
            <div className="row">
              <button type="button" className="secondary" onClick={() => void handleReadAloud(answer, "answer")} disabled={blocked}>
                Read answer aloud (local voice)
              </button>
              {speakingFor === "answer" && (
                <button type="button" className="secondary" onClick={handleStopSpeech}>
                  Stop
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>2 · Save a memory (explicit)</h2>
        <p className="note">
          Editable memory text — seeded from the answer above when empty, but you control exactly what is saved. Encrypted with AES-GCM before it
          touches IndexedDB, then uploaded as ciphertext only.
        </p>
        <textarea
          aria-label="Memory text"
          rows={6}
          value={memoryText}
          onChange={(event) => setMemoryText(event.target.value)}
          placeholder="The decision or fact to remember…"
          disabled={blocked}
        />
        <p className="note">
          Source label: <code>{memorySource}</code> (encrypted with the memory, together with creation time and purpose)
        </p>
        <div className="row">
          <button type="button" onClick={handleSaveMemory} disabled={saveStatus.kind === "loading" || keyUnavailable || blocked}>
            Save memory
          </button>
        </div>
        <StatusLine status={saveStatus} />
      </section>

      <section className="panel">
        <h2>3 · Follow-up with recall</h2>
        <textarea
          aria-label="Follow-up question"
          rows={3}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="e.g. What approach did we decide for Project Cedar, and what project codename did I save?"
          disabled={blocked}
        />
        <div className="row">
          <button type="button" onClick={handleCapture} disabled={captureStatus.kind === "picking" || captureStatus.kind === "capturing" || captureStatus.kind === "ocr" || blocked}>
            Capture screen context
          </button>
          <button type="button" onClick={handleRecall} disabled={recallStatus.kind === "loading" || keyUnavailable || blocked}>
            Recall memory
          </button>
          <button type="button" onClick={handleSend} disabled={!preview || recallStatus.kind === "loading" || blocked}>
            Send approved request
          </button>
        </div>
        {captureStatus.kind === "picking" && (
          <p className="note">Choose a screen, tab or window in the browser picker…{" "}
            <button type="button" className="secondary" onClick={handleCancelCapture}>Cancel</button>
          </p>
        )}
        {captureStatus.kind === "capturing" && <p className="note">Capturing one frame…</p>}
        {captureStatus.kind === "ocr" && (
          <p className="note">Extracting text locally in your browser… {Math.round(captureStatus.progress * 100)}%{" "}
            <button type="button" className="secondary" onClick={handleCancelCapture}>Cancel OCR</button>
          </p>
        )}
        {captureStatus.kind === "error" && <p className="note error-text">{captureStatus.message}</p>}
        {captureError && <p className="note error-text">{captureError}</p>}
        {captureStatus.kind === "review" && (
          <div className="recalled">
            <h3>Text extracted locally from your screen — review and edit before use</h3>
            <p className="note">
              OCR ran entirely in this browser on a single captured frame; the screenshot was never sent anywhere and is not stored. Nothing is
              sent to Mistral and no memory is saved until you use the existing approval flow.
            </p>
            <textarea
              aria-label="Reviewed extracted text"
              rows={8}
              value={ocrDraft}
              onChange={(event) => setOcrDraft(event.target.value)}
              disabled={blocked}
            />
            <div className="row">
              <button type="button" onClick={handleUseInFollowUp} disabled={blocked}>
                Use in follow-up
              </button>
              <button type="button" className="secondary" onClick={handleDiscardOcr}>
                Discard
              </button>
            </div>
          </div>
        )}
        <StatusLine status={recallStatus} />
        {recalled !== null && (
          <div className="recalled">
            <h3>Recalled memories (decrypted locally, transient)</h3>
            {recalled.length === 0 ? (
              <p className="note">No saved memories exist. Nothing was recalled and none will be sent.</p>
            ) : (
              <ul>
                {recalled.map((memory) => (
                  <li key={memory.artifactId}>
                    <code>{memory.artifactId.slice(0, 8)}…</code> · source <code>{memory.payload.provenance.source}</code> · created{" "}
                    {memory.payload.provenance.createdAt}
                    <pre>{memory.payload.text}</pre>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {preview && (
          <details className="preview" open>
            <summary>Outbound request preview — the complete messages array that Send will dispatch</summary>
            <pre>{JSON.stringify({ messages: preview.messages }, null, 2)}</pre>
            <p className="note">
              Memories supplied: {preview.memoryIds.map((id) => id.slice(0, 8) + "…").join(", ")}. {REDACTOR_LABEL} Any change to the question or the
              selected memories clears this preview and requires a new approval.
            </p>
          </details>
        )}
        {recallAnswer && (
          <div className="answer">
            <h3>Answer (memories used: {recallAnswer.memoryIds.map((id) => id.slice(0, 8) + "…").join(", ")})</h3>
            <pre>{recallAnswer.text}</pre>
            <div className="row">
              <button type="button" className="secondary" onClick={() => void handleReadAloud(recallAnswer.text, "recall")} disabled={blocked}>
                Read answer aloud (local voice)
              </button>
              {speakingFor === "recall" && (
                <button type="button" className="secondary" onClick={handleStopSpeech}>
                  Stop
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Memory panel</h2>
        <p>
          {memoryCount === null
            ? "Loading memory count…"
            : `${memoryCount} saved ${memoryCount === 1 ? "memory" : "memories"} (browser-encrypted; ciphertext also stored on the relay)`}
        </p>
        {panelMemories.length > 0 && (
          <ul className="memory-list">
            {panelMemories.map((memory) => (
              <li key={memory.artifactId}>
                <code>{memory.artifactId.slice(0, 8)}…</code> · source <code>{memory.payload.provenance.source}</code> · created{" "}
                {memory.payload.provenance.createdAt} · purpose: {memory.payload.provenance.purpose} ·{" "}
                {uploadStates[memory.artifactId] === "uploaded"
                  ? "uploaded (relay acknowledged)"
                  : uploadStates[memory.artifactId] === "uploading"
                    ? "uploading…"
                    : "saved locally, awaiting upload"}
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <button type="button" className="secondary" onClick={handleUploadPending} disabled={blocked || pullStatus.kind === "loading"}>
            Upload pending memories
          </button>
          <button type="button" className="secondary" onClick={handlePullRemote} disabled={blocked || pullStatus.kind === "loading" || keyUnavailable}>
            Fetch remote copies
          </button>
        </div>
        <StatusLine status={pullStatus} />
      </section>

      <section className="panel">
        <h2>Memory trail</h2>
        <p className="note">
          Decrypted locally for display only; nothing here is persisted beyond the encrypted artifacts. Usage receipts are
          transient and labeled “This conversation” — New conversation and Forget Me clear them. Inclusion in a request does not
          mean the model relied on that memory.
        </p>
        {panelMemories.length === 0 && usage.length === 0 && <p className="note">Nothing yet — save a memory or send a request.</p>}
        {panelMemories.length > 0 && (
          <ul className="memory-list">
            {panelMemories.map((memory) => {
              const origin = originDisplay(memory);
              const receipts = receiptsForMemory(usage, memory.artifactId);
              const upload = uploadStates[memory.artifactId];
              const uploadLabel =
                upload === "uploaded" ? "uploaded (relay acknowledged)" : upload === "uploading" ? "uploading…" : "saved locally, awaiting upload";
              return (
                <li key={memory.artifactId}>
                  <details>
                    <summary>
                      <code>{memory.artifactId.slice(0, 8)}…</code> · {uploadLabel} · origin: {origin.text}
                    </summary>
                    <pre>{memory.payload.text}</pre>
                    <p className="note">
                      artifact ID <code>{memory.artifactId}</code> · created {origin.createdAt ?? memory.payload.provenance.createdAt} · source
                      label <code>{memory.payload.provenance.source}</code>
                    </p>
                    {receipts.length > 0 ? (
                      <ul className="memory-list">
                        {receipts.map((receipt) => (
                          <li key={receipt.requestId}>
                            Included in request <code>{receipt.requestId.slice(0, 8)}…</code> (Mistral Mind request ID) — status: {receipt.status}
                            <details>
                              <summary>approved outbound snapshot for that request</summary>
                              <pre>{JSON.stringify({ messages: receipt.snapshot }, null, 2)}</pre>
                            </details>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="note">Not included in any request this conversation.</p>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
        )}
        {usage.length > 0 && (
          <>
            <h3>Requests this conversation</h3>
            <ul className="memory-list">
              {usage.map((receipt) => (
                <li key={receipt.requestId}>
                  Mistral Mind request <code>{receipt.requestId.slice(0, 8)}…</code> · status: {receipt.status} · memories included:{" "}
                  {receipt.memoryIds.length > 0 ? receipt.memoryIds.map((id) => id.slice(0, 8) + "…").join(", ") : "none"}
                  {receipt.inputLabel ? <> · input: <em>{receipt.inputLabel}</em></> : null}
                  <details>
                    <summary>approved outbound snapshot</summary>
                    <pre>{JSON.stringify({ messages: receipt.snapshot }, null, 2)}</pre>
                  </details>
                  {receipt.status === "answered" && receipt.answerText !== undefined && <pre>{receipt.answerText}</pre>}
                  {receipt.status === "failed" && <p className="note error-text">{receipt.error}</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
        </>
      )}

      {demoMode && (
        <EvidencePanel
          sections={evidenceSections}
          onInspectLocal={handleInspectLocal}
          onFetchServer={handleFetchServerStatus}
          inspecting={inspecting}
          fetching={fetchingStatus}
          canFetch={vaultState.status === "ready" && !blocked}
        />
      )}
    </main>
  );
}
