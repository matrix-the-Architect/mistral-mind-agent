/**
 * Milestone 3: the Memory trail's pure display/event logic. No storage of its own — usage
 * receipts live in transient React state ("This conversation"), origin details come from the
 * decrypted payload's encrypted provenance. Everything here is testable without a browser.
 */

import type { DecryptedMemory, MemoryProvenance, OutboundMessage } from "./types";

export const ORIGIN_NOT_RECORDED = "Origin not recorded.";

/** How the origin of one memory is displayed. Old records (no structured provenance) say so. */
export interface OriginDisplay {
  text: string;
  sourceKind?: MemoryProvenance["sourceKind"];
  sourceAnalysisId?: string;
  createdAt?: string;
  editedBeforeSave?: boolean;
}

export function originDisplay(memory: DecryptedMemory): OriginDisplay {
  const provenance = memory.payload.provenance;
  const hasCreation =
    provenance.sourceKind !== undefined ||
    provenance.sourceAnalysisId !== undefined ||
    provenance.editedBeforeSave !== undefined;
  if (!hasCreation) {
    // Ciphertext from before milestone 3: no structured origin was recorded. Never fabricate one.
    return { text: ORIGIN_NOT_RECORDED, createdAt: provenance.createdAt };
  }
  const kindLabel = provenance.sourceKind === "saved-from-analysis" ? "saved from analysis" : "user-entered";
  const ghostId = provenance.sourceAnalysisId
    ? ` · Ghost analysis ID ${provenance.sourceAnalysisId.slice(0, 8)}… (app-generated, not a provider request ID)`
    : "";
  const edited =
    provenance.editedBeforeSave === undefined
      ? ""
      : provenance.editedBeforeSave
        ? " · edited before save"
        : " · saved unedited";
  return {
    text: `${kindLabel}${ghostId}${edited}`,
    sourceKind: provenance.sourceKind,
    sourceAnalysisId: provenance.sourceAnalysisId,
    createdAt: provenance.createdAt,
    editedBeforeSave: provenance.editedBeforeSave,
  };
}

/** What to record for a NEW memory: only the four milestone-3 fields, inside the encrypted payload. */
export function creationProvenance(args: {
  /** The analysis that seeded the memory field, if this save came from one. */
  seeded: { analysisId: string; text: string } | null;
  memoryText: string;
}): Pick<MemoryProvenance, "sourceKind" | "sourceAnalysisId" | "editedBeforeSave"> {
  if (args.seeded) {
    return {
      sourceKind: "saved-from-analysis",
      sourceAnalysisId: args.seeded.analysisId,
      editedBeforeSave: args.memoryText !== args.seeded.text,
    };
  }
  // No proposed memory existed, so "edited before save" is vacuously false — not fabricated.
  return { sourceKind: "user-entered", editedBeforeSave: false };
}

/**
 * One outbound request of THIS conversation, kept in transient state only. `snapshot` is the
 * exact approved messages array that was (or will be) submitted; `memoryIds` are the artifact
 * IDs included in it. A request is "answered" only after a successful relay response.
 */
export interface UsageReceipt {
  /** Application-generated ID of this conversation request (a Ghost ID, not a provider ID). */
  requestId: string;
  status: "pending" | "failed" | "answered";
  memoryIds: string[];
  snapshot: OutboundMessage[];
  at: string;
  /** Set when the request reached a terminal state (answered/failed), for elapsed-time display. */
  completedAt?: string;
  answerText?: string;
  error?: string;
  /** e.g. "Text extracted locally from your screen" when the question came from a reviewed capture. */
  inputLabel?: string;
}

/** The receipts in which a memory artifact was included. */
export function receiptsForMemory(usage: readonly UsageReceipt[], artifactId: string): UsageReceipt[] {
  return usage.filter((receipt) => receipt.memoryIds.includes(artifactId));
}

/** True when the receipt's snapshot is exactly the approved messages array (reference equality of contents). */
export function snapshotMatches(receipt: UsageReceipt, messages: readonly OutboundMessage[]): boolean {
  return (
    receipt.snapshot.length === messages.length &&
    receipt.snapshot.every((message, index) => message.role === messages[index]?.role && message.content === messages[index]?.content)
  );
}
