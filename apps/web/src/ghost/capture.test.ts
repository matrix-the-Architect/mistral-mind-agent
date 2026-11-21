/**
 * Milestone 4 tests: the single-capture lifecycle guards and composition, all pure/unit-level.
 * No real getDisplayMedia or Tesseract worker is exercised here — the real-browser capture is a
 * manual check. These tests pin the guarantees that late results can never repopulate the UI.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  composeFollowUp,
  discardStreamIfStale,
  FOLLOW_UP_INSTRUCTION,
  isCaptureCurrent,
  MAX_FOLLOW_UP_CHARS,
  stopStream,
  waitForVideoReady,
} from "./capture";
import { recognizeGuarded } from "./ocr";
import type { OcrController } from "./ocr";

const PAIR = { namespaceId: "ns-a", generation: 1 };

function currentArgs(overrides: Partial<Parameters<typeof isCaptureCurrent>[0]> = {}) {
  return {
    forgetting: false,
    active: PAIR,
    captured: PAIR,
    currentOperationId: "op-1",
    operationId: "op-1",
    mounted: true,
    ...overrides,
  };
}

describe("isCaptureCurrent lifecycle guard", () => {
  test("current operation on the same pair is admitted", () => {
    expect(isCaptureCurrent(currentArgs())).toBe(true);
  });

  test("a different namespace is rejected even at the same generation", () => {
    expect(isCaptureCurrent(currentArgs({ active: { namespaceId: "ns-b", generation: 1 } }))).toBe(false);
  });

  test("a different generation on the same namespace is rejected", () => {
    expect(isCaptureCurrent(currentArgs({ active: { namespaceId: "ns-a", generation: 2 } }))).toBe(false);
  });

  test("forgetting state rejects", () => {
    expect(isCaptureCurrent(currentArgs({ forgetting: true }))).toBe(false);
  });

  test("no active vault (forgotten/unavailable) rejects", () => {
    expect(isCaptureCurrent(currentArgs({ active: null }))).toBe(false);
  });

  test("a stale operation id rejects (another capture started)", () => {
    expect(isCaptureCurrent(currentArgs({ currentOperationId: "op-2" }))).toBe(false);
  });

  test("operation id cleared (cancelled) rejects", () => {
    expect(isCaptureCurrent(currentArgs({ currentOperationId: null }))).toBe(false);
  });

  test("unmounted component rejects", () => {
    expect(isCaptureCurrent(currentArgs({ mounted: false }))).toBe(false);
  });
});

describe("composeFollowUp", () => {
  test("prepends the editable instruction", () => {
    const result = composeFollowUp("steps: 1) a 2) b");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.question.startsWith(FOLLOW_UP_INSTRUCTION)).toBe(true);
      expect(result.question.endsWith("steps: 1) a 2) b")).toBe(true);
    }
  });

  test("rejects text that would exceed the request-size limit with a clear error", () => {
    const result = composeFollowUp("x".repeat(MAX_FOLLOW_UP_CHARS));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("too large");
  });
});

describe("stream lifecycle", () => {
  function fakeStream(): MediaStream & { tracks: { stopped: boolean; stop: () => void }[] } {
    const tracks = [0, 1].map(() => {
      const track = { stopped: false, stop() { track.stopped = true; } };
      return track;
    });
    return { tracks, getTracks: () => tracks } as unknown as MediaStream & {
      tracks: { stopped: boolean; stop: () => void }[];
    };
  }

  test("stopStream stops every track and tolerates null", () => {
    const stream = fakeStream();
    stopStream(stream);
    expect(stream.tracks.every((track) => track.stopped)).toBe(true);
    stopStream(null);
    stopStream(undefined);
  });

  test("discardStreamIfStale stops and reports a late-granted stream; keeps a current one", () => {
    const stale = fakeStream();
    expect(discardStreamIfStale(stale, false)).toBe(true);
    expect(stale.tracks.every((track) => track.stopped)).toBe(true);
    const live = fakeStream();
    expect(discardStreamIfStale(live, true)).toBe(false);
    expect(live.tracks.every((track) => !track.stopped)).toBe(true);
  });
});

describe("waitForVideoReady", () => {
  interface FakeVideo {
    videoWidth: number;
    videoHeight: number;
    addEventListener: (event: string, fn: () => void) => void;
    removeEventListener: (event: string, fn: () => void) => void;
    fire: (event: string) => void;
  }

  function fakeVideo(): HTMLVideoElement & FakeVideo {
    const listeners = new Map<string, (() => void)[]>();
    const video: FakeVideo = {
      videoWidth: 0,
      videoHeight: 0,
      addEventListener: (event: string, fn: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
      removeEventListener: (event: string, fn: () => void) =>
        listeners.set(event, (listeners.get(event) ?? []).filter((existing) => existing !== fn)),
      fire: (event: string) => (listeners.get(event) ?? []).forEach((fn) => fn()),
    };
    return video as unknown as HTMLVideoElement & FakeVideo;
  }

  test("resolves immediately when dimensions are already valid", async () => {
    const video = fakeVideo();
    video.videoWidth = 640;
    video.videoHeight = 480;
    await waitForVideoReady(video, 30);
  });

  test("resolves on loadedmetadata once dimensions are valid", async () => {
    const video = fakeVideo();
    const pending = waitForVideoReady(video, 1000);
    video.videoWidth = 640;
    video.videoHeight = 480;
    video.fire("loadedmetadata");
    await pending;
  });

  test("rejects on the bounded timeout when no frame arrives", async () => {
    const video = fakeVideo();
    await expect(waitForVideoReady(video, 30)).rejects.toThrow(/Timed out/);
  });

  test("rejects on stream error", async () => {
    const video = fakeVideo();
    const pending = waitForVideoReady(video, 1000);
    video.fire("error");
    await expect(pending).rejects.toThrow(/ended before a frame/);
  });
});

describe("recognizeGuarded", () => {
  function fakeCanvas(): HTMLCanvasElement {
    return {} as HTMLCanvasElement;
  }

  function fakeOcr(text: string | Error): OcrController {
    return {
      terminated: false,
      recognize: async () => {
        if (text instanceof Error) throw text;
        return text;
      },
      cancel: async () => undefined,
    };
  }

  test("returns the text when the capture is still current", async () => {
    const text = await recognizeGuarded({ canvas: fakeCanvas(), ocr: fakeOcr("hello screen"), isCurrent: () => true });
    expect(text).toBe("hello screen");
  });

  test("discards the late OCR result (null) when the capture became stale — e.g. after Forget Me", async () => {
    let current = true;
    const ocr: OcrController = {
      terminated: false,
      recognize: async () => {
        current = false; // Forget Me lands while OCR is running
        return "secret screen text";
      },
      cancel: async () => undefined,
    };
    const text = await recognizeGuarded({ canvas: fakeCanvas(), ocr, isCurrent: () => current });
    expect(text).toBeNull();
  });

  test("OCR failures propagate to the caller", async () => {
    await expect(
      recognizeGuarded({ canvas: fakeCanvas(), ocr: fakeOcr(new Error("worker crashed")), isCurrent: () => true })
    ).rejects.toThrow("worker crashed");
  });
});

describe("no network or persistence leakage in the capture modules", () => {
  test("capture.ts and ocr.ts never call fetch/postInference or touch storage", () => {
    for (const file of ["capture.ts", "ocr.ts"]) {
      const raw = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      // Scan code only, not doc comments that merely mention the words.
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/postInference/);
      expect(source).not.toMatch(/\bindexedDB\b|localStorage|sessionStorage|\bcaches\s*\./i);
      expect(source).not.toMatch(/console\.(log|info|debug)/);
    }
  });
});
