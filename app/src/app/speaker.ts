// The app's one voice. Every prompt (navigation, answers, announcements) goes
// through here, in order:
//   - Abdullah's Piper voice from the local service (app/sidecar), when it is
//     running: the same voice everywhere in the app;
//   - otherwise the device's own voice (speechSynthesis), so it still talks
//     offline with no service.
// "interrupt" requests (off route, poor GPS, reroute) cut off what is playing.
// Screen-reader users and "Speak prompts" off: nothing is spoken here; the
// live region carries every prompt in their own screen reader's voice.

import type { SpeakRequest } from '../contracts';
import { piperWav, sidecarHealth } from '../vision/sidecar';

export interface SpeakOptions {
  enabled: boolean;
  rate: number;
}

let piperReady = false;
let checked = 0;
async function piperAvailable(): Promise<boolean> {
  // Check the service at most every 10 seconds; it may start or stop at any time.
  if (Date.now() - checked > 10_000) {
    checked = Date.now();
    const h = await sidecarHealth();
    piperReady = !!h && h.voice;
  }
  return piperReady;
}

const cache = new Map<string, string>();
const queue: Array<{ text: string; rate: number }> = [];
let current: HTMLAudioElement | null = null;
/** Ends the wait for whatever is playing now: an interrupt must never leave the queue waiting. */
let finishCurrent: (() => void) | null = null;
let busy = false;
let generation = 0; // bumps on interrupt, so a slow Piper reply for an old prompt is dropped

/** Silence everything that could be playing: one voice at a time, always. */
function silence() {
  if (current) {
    current.onended = current.onerror = null;
    current.pause();
    current.removeAttribute('src');
    current = null;
  }
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

/**
 * Wait for one utterance, but never forever: browsers do not always report
 * the end (autoplay blocked, no voices). When the limit passes, the sound is
 * stopped too, so the next prompt can never play on top of it.
 */
function finishOnce(start: (done: () => void, setLimit: (ms: number) => void) => void, limitMs: number): Promise<void> {
  return new Promise((resolve) => {
    let over = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      finishCurrent = null;
      silence();
      resolve();
    };
    const setLimit = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    };
    setLimit(limitMs);
    finishCurrent = done;
    start(done, setLimit);
  });
}

/** Rough speaking time for the device voice: ~12 characters a second at rate 1, plus slack. */
const limitFor = (text: string, rate: number) => (text.length / 12 / Math.max(0.5, rate)) * 1000 + 3000;

function deviceVoice(text: string, rate: number): Promise<void> {
  return finishOnce((done) => {
    if (typeof speechSynthesis === 'undefined') return done();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.lang = 'en-GB';
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  }, limitFor(text, rate));
}

function playWav(b64: string, rate: number): Promise<void> {
  return finishOnce((done, setLimit) => {
    silence();
    const a = new Audio(`data:audio/wav;base64,${b64}`);
    a.playbackRate = rate; // pitch is preserved by the browser
    current = a;
    // The real length of this clip, once known (a long answer can run 30 s).
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration)) setLimit((a.duration / rate) * 1000 + 1500);
    };
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  }, 60_000);
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const { text, rate } = queue.shift()!;
      const gen = generation;
      let wav: string | null = cache.get(text) ?? null;
      if (!wav && (await piperAvailable())) {
        wav = await piperWav(text);
        if (wav) {
          if (cache.size > 300) cache.clear();
          cache.set(text, wav);
        } else piperReady = false;
      }
      if (gen !== generation) continue; // replaced while Piper was working
      if (wav) await playWav(wav, rate);
      else await deviceVoice(text, rate);
    }
  } finally {
    busy = false;
  }
}

/**
 * Speak one prompt.
 *  - "interrupt": stop what is playing, drop what is waiting, say this now. Used for
 *    everything the person asked for (a button, a question) and for safety prompts.
 *  - "queue": wait for the current prompt (guidance said together: crossing, then turn).
 */
export function say(req: SpeakRequest, opts: SpeakOptions) {
  if (!opts.enabled || !req.text) return;
  if (req.priority === 'interrupt') stopSpeaking();
  else if (queue.length >= 2) queue.splice(0, queue.length - 1); // never build a long backlog
  queue.push({ text: req.text, rate: opts.rate });
  void pump();
}

export function stopSpeaking() {
  generation++;
  queue.length = 0;
  silence();
  finishCurrent?.(); // release the queue, which was waiting for that clip to end
}

// Vite hot reload: stop the old module's voice, so two copies never talk at once.
import.meta.hot?.dispose(() => stopSpeaking());

/** Ask the service now (e.g. when settings open), instead of waiting up to 10 s. */
export async function refreshVoice(): Promise<boolean> {
  checked = 0;
  return piperAvailable();
}
