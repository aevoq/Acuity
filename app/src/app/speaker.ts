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
let busy = false;
let generation = 0; // bumps on interrupt, so a slow Piper reply for an old prompt is dropped

function deviceVoice(text: string, rate: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.lang = 'en-GB';
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

function playWav(b64: string, rate: number): Promise<void> {
  return new Promise((resolve) => {
    const a = new Audio(`data:audio/wav;base64,${b64}`);
    a.playbackRate = rate; // pitch is preserved by the browser
    current = a;
    a.onended = a.onerror = () => {
      current = null;
      resolve();
    };
    a.play().catch(() => {
      current = null;
      resolve();
    });
  });
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const { text, rate } = queue.shift()!;
    const gen = generation;
    let wav: string | null = cache.get(text) ?? null;
    if (!wav && (await piperAvailable())) {
      wav = await piperWav(text);
      if (wav) cache.size > 300 ? cache.clear() : cache.set(text, wav);
      else piperReady = false;
    }
    if (gen !== generation) continue; // interrupted while Piper was working
    if (wav) await playWav(wav, rate);
    else await deviceVoice(text, rate);
  }
  busy = false;
}

export function say(req: SpeakRequest, opts: SpeakOptions) {
  if (!opts.enabled || !req.text) return;
  if (req.priority === 'interrupt') stopSpeaking();
  queue.push({ text: req.text, rate: opts.rate });
  void pump();
}

export function stopSpeaking() {
  generation++;
  queue.length = 0;
  current?.pause();
  current = null;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

/** Ask the service now (e.g. when settings open), instead of waiting up to 10 s. */
export async function refreshVoice(): Promise<boolean> {
  checked = 0;
  return piperAvailable();
}
