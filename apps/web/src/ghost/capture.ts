/**
 * Single-frame screen capture helpers. `pickDisplayStream` MUST be called directly from the
 * user's click handler (before any unrelated await) so the browser's user activation is intact
 * for the permission picker. One frame is drawn to a local canvas and ALL stream tracks are
 * stopped immediately afterwards — before OCR starts — and also on error/cancel. No continuous
 * recording, no automatic recapture, no object URLs.
 *
 * The lifecycle guard (`isCaptureCurrent`) is pure and unit-tested: every asynchronous result is
 * applied only if the same (namespaceId, generation) pair is still active, the vault is not
 * forgetting/forgotten, the capture operation is still current, and the component is mounted.
 */

/** Bounded wait for a usable video frame. */
export const FRAME_READY_TIMEOUT_MS = 5_000;

export function displayCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function"
  );
}

/** Ask the user to pick a screen/tab/window. Video only, audio never. Call in the click handler. */
export function pickDisplayStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
}

/** Stop every track of a stream (idempotent). */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already stopped
    }
  }
}

/** Detach a video element from its stream so no frame can be drawn or retained. */
export function releaseVideo(video: HTMLVideoElement | null | undefined): void {
  if (!video) return;
  video.srcObject = null;
  video.removeAttribute("src");
  try {
    video.load();
  } catch {
    // ignore
  }
}

/** Resolve once the video has non-zero dimensions; reject on timeout or stream error. */
export function waitForVideoReady(video: HTMLVideoElement, timeoutMs: number = FRAME_READY_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      resolve();
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a video frame from the capture stream."));
    }, timeoutMs);
    const onReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("The capture stream ended before a frame was ready."));
    };
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
  });
}

/** Draw the current video frame onto a fresh local canvas. */
export function drawVideoFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not get a 2D canvas context for the frame.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Free a canvas' backing buffer once the frame has been consumed. */
export function releaseCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * The picker race: if the capture became stale while the browser's permission picker was still
 * open, a stream granted afterwards is stopped immediately and discarded. Returns true when the
 * stream was discarded.
 */
export function discardStreamIfStale(stream: MediaStream, current: boolean): boolean {
  if (!current) {
    stopStream(stream);
    return true;
  }
  return false;
}

/** Pure lifecycle guard for every asynchronous capture/OCR result. */
export function isCaptureCurrent(args: {
  forgetting: boolean;
  active: { namespaceId: string; generation: number } | null;
  captured: { namespaceId: string; generation: number };
  currentOperationId: string | null;
  operationId: string;
  mounted: boolean;
}): boolean {
  if (!args.mounted || args.forgetting) return false;
  if (args.currentOperationId !== args.operationId) return false;
  const active = args.active;
  return (
    active !== null &&
    active.namespaceId === args.captured.namespaceId &&
    active.generation === args.captured.generation
  );
}

/** The editable instruction prepended when the reviewed text is used in a follow-up. */
export const FOLLOW_UP_INSTRUCTION = "Review this proposed workflow against my saved constraints:";

// The relay caps one message at 20_000 chars and the whole body at 64 KiB; stay well under.
export const MAX_FOLLOW_UP_CHARS = 16_000;

/** Compose the follow-up question from reviewed extracted text; clear error when too large. */
export function composeFollowUp(
  text: string,
  maxChars: number = MAX_FOLLOW_UP_CHARS
): { ok: true; question: string } | { ok: false; error: string } {
  const question = `${FOLLOW_UP_INSTRUCTION}\n\n${text}`;
  if (question.length > maxChars) {
    return {
      ok: false,
      error: `The extracted text is too large to send (${question.length} characters; the limit is ${maxChars}). Trim it in the review box first.`,
    };
  }
  return { ok: true, question };
}
