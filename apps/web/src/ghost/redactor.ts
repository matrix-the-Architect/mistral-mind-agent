/**
 * A small, deterministic DEMONSTRATION redactor applied to the complete outbound context
 * (including recalled memories) before it is previewed and sent.
 *
 * Coverage, honestly labeled: obvious synthetic email addresses and known demo-token patterns
 * (`tok_…`, `sk_…`, `mstrl_…` and similar). It is NOT comprehensive PII detection and must not
 * be relied on as one.
 */

import type { OutboundMessage } from "./types";

export const REDACTOR_LABEL =
  "Demo redactor applied to the whole outbound context: synthetic email addresses and demo token patterns (tok_…, sk_…, mstrl_…) only — not comprehensive PII detection.";

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DEMO_TOKEN_PATTERN = /\b(?:tok|sk|pk|rk|key|mstrl)_[A-Za-z0-9_-]{8,}\b/g;

export function redactText(text: string): string {
  return text.replace(EMAIL_PATTERN, "[redacted-email]").replace(DEMO_TOKEN_PATTERN, "[redacted-demo-token]");
}

/** Redact every message's content, producing the snapshot that is both previewed and sent. */
export function redactMessages(messages: OutboundMessage[]): OutboundMessage[] {
  return messages.map((message) => ({ ...message, content: redactText(message.content) }));
}
