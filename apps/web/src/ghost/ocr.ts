/**
 * Browser-only OCR: Tesseract.js (English, LSTM core), loaded LAZILY via dynamic import so
 * TanStack server rendering never evaluates browser APIs. All worker/WASM/language assets are
 * served locally from /ocr (vendored into public/ocr) — no CDN and no remote OCR service. The
 * canvas is handed directly to the in-browser worker; screenshots, image bytes and data URLs
 * never reach API requests, logs, IndexedDB or caches. Only the recognized text returns, and it
 * is never logged. The worker is terminated when the job finishes, is cancelled, or fails.
 */

export interface OcrProgress {
  status: string;
  progress: number;
}

export interface OcrController {
  /** Recognize one canvas; resolves with the text. Terminates the worker afterwards. */
  recognize(canvas: HTMLCanvasElement, onProgress?: (progress: OcrProgress) => void): Promise<string>;
  /** Cancel an in-flight job and terminate the worker. Safe to call anytime. */
  cancel(): Promise<void>;
  readonly terminated: boolean;
}

// Local asset paths (apps/web/public/ocr): worker script, LSTM wasm core, gzipped English data.
const WORKER_PATH = "/ocr/worker.min.js";
const CORE_PATH = "/ocr/tesseract-core-lstm.wasm.js";
const LANG_PATH = "/ocr/lang";

export function createOcrController(): OcrController {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tesseract.js worker is untyped at runtime
  let worker: any = null;
  let terminated = false;

  async function terminateWorker(): Promise<void> {
    terminated = true;
    const w = worker;
    worker = null;
    if (w) {
      try {
        await w.terminate();
      } catch {
        // already gone
      }
    }
  }

  return {
    get terminated() {
      return terminated;
    },
    async recognize(canvas, onProgress) {
      if (terminated) throw new Error("The OCR worker was already terminated.");
      // The only browser-only evaluation: dynamic import, triggered by a user click.
      const tesseract = await import("tesseract.js");
      worker = await tesseract.createWorker("eng", tesseract.OEM.LSTM_ONLY, {
        workerPath: WORKER_PATH,
        corePath: CORE_PATH,
        langPath: LANG_PATH,
        gzip: true,
        // Nothing is written to the Cache API; language data comes from the local /ocr/lang file.
        cacheMethod: "none",
        workerBlobURL: false,
        logger: (message: { status?: string; progress?: number }) => {
          if (message?.status === "recognizing text" && onProgress) {
            onProgress({ status: message.status, progress: message.progress ?? 0 });
          }
        },
      });
      try {
        const result = await worker.recognize(canvas);
        return String(result.data.text);
      } finally {
        await terminateWorker();
      }
    },
    async cancel() {
      await terminateWorker();
    },
  };
}

/**
 * Run OCR and apply the lifecycle guard to its result: if the capture became stale while OCR was
 * running (Forget Me, new capture, cancel, unmount), the late text is discarded (null) and never
 * repopulates the UI.
 */
export async function recognizeGuarded(args: {
  canvas: HTMLCanvasElement;
  ocr: OcrController;
  isCurrent: () => boolean;
  onProgress?: (progress: OcrProgress) => void;
}): Promise<string | null> {
  const text = await args.ocr.recognize(args.canvas, args.onProgress);
  return args.isCurrent() ? text : null;
}
