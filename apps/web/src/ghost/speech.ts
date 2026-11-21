/**
 * Milestone 5 optional: local "Read answer aloud" via the browser's speech synthesis. LOCAL VOICES
 * ONLY (voice.localService === true) — there is never a remote fallback, and no microphone access
 * (getUserMedia is never called). Voices can appear asynchronously, so callers await
 * {@link waitForLocalVoices} before starting; the start itself is re-guarded by the caller's
 * isCurrent() (active namespace/generation pair, not forgetting, still mounted) so a delayed start
 * after Forget Me never speaks. Everything is cancelled on Forget Me / New conversation / new
 * session / unmount / cross-tab forgetting.
 */

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof window.speechSynthesis !== "undefined";
}

let currentUtterance: SpeechSynthesisUtterance | null = null;
let voicesChangedFired = false;

function pickLocalVoice(): SpeechSynthesisVoice | null {
  if (!speechSupported()) return null;
  const voices = window.speechSynthesis.getVoices().filter((voice) => voice.localService);
  if (voices.length === 0) return null;
  return voices.find((voice) => voice.lang.toLowerCase().startsWith("en")) ?? voices[0] ?? null;
}

/** Resolves once voices are known (immediately if already loaded, else on voiceschanged). */
export function waitForLocalVoices(timeoutMs = 2000): Promise<void> {
  if (!speechSupported()) return Promise.resolve();
  if (window.speechSynthesis.getVoices().length > 0 || voicesChangedFired) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      voicesChangedFired = true;
      resolve();
    };
    window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    // Bounded wait: some browsers never fire it.
    setTimeout(done, timeoutMs);
  });
}

/** True when at least one LOCAL voice exists (no remote voice is ever used). */
export function localVoiceAvailable(): boolean {
  return pickLocalVoice() !== null;
}

/**
 * Speak `text` with a local voice. Returns false when speech is unsupported, no local voice exists,
 * or the guard rejected the (possibly delayed) start. Cancels anything currently speaking first.
 */
export function speakLocal(text: string, opts: { isCurrent: () => boolean }): boolean {
  if (!speechSupported()) return false;
  stopSpeech();
  const voice = pickLocalVoice();
  if (!voice) return false;
  if (!opts.isCurrent()) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.onend = () => {
    if (currentUtterance === utterance) currentUtterance = null;
  };
  utterance.onerror = () => {
    if (currentUtterance === utterance) currentUtterance = null;
  };
  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
  return true;
}

/** Cancel current and queued speech. */
export function stopSpeech(): void {
  if (speechSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
  currentUtterance = null;
}

export function isSpeaking(): boolean {
  return currentUtterance !== null;
}
