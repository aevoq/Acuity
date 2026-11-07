// Acuity's ears: one microphone, two ways of listening.
//   "open"  — the next thing the person says (after Acuity asks a question).
//   "wake"  — always on during a walk, but only "Hey Acuity …" counts.
// Speech is found locally with a simple voice-activity check, so only the
// moments someone speaks are transcribed, by Abdullah's Whisper in the local
// service (offline). Everything heard while the app itself is talking is
// thrown away, so Acuity never wakes herself up. Without the service, the
// browser's own speech recognition is used instead.

import { isSpeaking, onSpeakingChange } from '../app/speaker';
import { sidecarHealth, transcribeSpeech } from '../vision/sidecar';

export type EarsState = 'off' | 'wake' | 'listening' | 'hearing' | 'thinking';

export interface EarsOptions {
  onState: (s: EarsState) => void;
  /** A finished utterance (already transcribed). `mode` says how it was heard. */
  onUtterance: (text: string, mode: 'open' | 'wake') => void;
}

const WAKE_HINT = 'Hey Acuity. Hey Acuity, what is around me? Where is the nearest bench?';
const MIN_VOICE_S = 0.45; // this much actual voice (not counting the pre-roll), or it was a noise

/**
 * What Whisper "hears" in silence, breath or traffic (it has learned these from
 * subtitles). Never acted on, so a quiet room can't talk to Acuity.
 */
const PHANTOMS = /^(thank you( very much| so much)?|thanks( for watching)?|you|bye|bye bye|okay|ok|so|um+|uh+|hmm+|ah+|oh|yeah|music|applause|silence|the end|i|a|\.+)$/;
export function isPhantom(text: string): boolean {
  const t = text.toLowerCase().replace(/[\[\]().,!?…"'*-]/g, ' ').replace(/\s+/g, ' ').trim();
  return !t || PHANTOMS.test(t) || t.split(' ').every((w) => w.length <= 1);
}
const PREROLL_S = 0.5; // keep the half-second before speech, so "Hey" isn't cut off
const END_SILENCE_S = 0.9;
const MAX_UTTERANCE_S = 9;
const OPEN_TIMEOUT_S = 9; // "open" mode gives up if nobody speaks

/** 16-bit PCM WAV at 16 kHz from float samples at `rate`. */
function wavBase64(samples: Float32Array, rate: number): string {
  const target = 16000;
  const ratio = rate / target;
  const n = Math.floor(samples.length / ratio);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, target, true);
  v.setUint32(28, target * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[Math.floor(i * ratio)]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void;
  onerror: () => void;
  onend: () => void;
  start(): void;
  stop(): void;
};

export function createEars({ onState, onUtterance }: EarsOptions) {
  let mode: 'off' | 'open' | 'wake' = 'off';
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: ScriptProcessorNode | null = null;
  let useWhisper = false;
  let recog: Recognition | null = null;
  let quietUntil = 0; // ignore the mic until then (the app has just stopped talking)
  let openTimer: ReturnType<typeof setTimeout> | null = null;

  const setMode = (m: typeof mode) => {
    mode = m;
    if (openTimer) clearTimeout(openTimer);
    openTimer = null;
    if (m === 'open') {
      // Give up if nobody answers, counting only from when the app stops talking
      // (and never while the person is still speaking).
      const tick = () => {
        if (mode !== 'open') return;
        if (isSpeaking() || capture) {
          openTimer = setTimeout(tick, 500);
          return;
        }
        mode = wakeArmed ? 'wake' : 'off';
        onState(mode === 'wake' ? 'wake' : 'off');
      };
      const wait = () => {
        if (mode !== 'open') return;
        if (isSpeaking()) openTimer = setTimeout(wait, 300);
        else openTimer = setTimeout(tick, OPEN_TIMEOUT_S * 1000);
      };
      openTimer = setTimeout(wait, 200);
    }
    onState(m === 'off' ? 'off' : m === 'open' ? 'listening' : 'wake');
  };
  let wakeArmed = false;

  onSpeakingChange((on) => {
    if (!on) quietUntil = performance.now() + 450; // the room still echoes for a moment
  });

  // ---- voice activity + capture (Whisper path)
  let ring: Float32Array[] = [];
  let ringLen = 0;
  let capture: Float32Array[] | null = null;
  let captureLen = 0;
  let silence = 0;
  let voiced = 0;
  let floor = 0.004;

  async function finish(samples: Float32Array[], rate: number) {
    const total = samples.reduce((a, b) => a + b.length, 0);
    if (total < rate * 0.35) return; // too short to be words
    const all = new Float32Array(total);
    let o = 0;
    for (const s of samples) {
      all.set(s, o);
      o += s.length;
    }
    const heardIn = mode === 'open' ? 'open' : 'wake';
    if (heardIn === 'open') onState('thinking');
    let text = '';
    try {
      text = (await transcribeSpeech(wavBase64(all, rate), WAKE_HINT)).text?.trim() ?? '';
    } catch {
      text = '';
    }
    if (mode === 'off') return; // stopped meanwhile
    if (!text || isPhantom(text)) {
      if (heardIn === 'open') onState('listening'); // keep waiting for a real answer
      return;
    }
    if (heardIn === 'open') onState('thinking');
    onUtterance(text, heardIn);
  }

  function onAudio(e: AudioProcessingEvent) {
    if (mode === 'off') return;
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    const rate = e.inputBuffer.sampleRate;
    const secs = data.length / rate;
    // While the app talks (and just after), nothing counts.
    if (isSpeaking() || performance.now() < quietUntil) {
      capture = null;
      ring = [];
      ringLen = 0;
      return;
    }
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const speech = rms > Math.max(0.02, floor * 4);
    if (!speech && !capture) floor = floor * 0.95 + rms * 0.05; // learn the room's noise

    if (capture) {
      capture.push(data);
      captureLen += data.length;
      silence = speech ? 0 : silence + secs;
      if (speech) voiced += secs;
      if (silence >= END_SILENCE_S || captureLen / rate >= MAX_UTTERANCE_S) {
        const got = capture;
        capture = null;
        const enough = voiced >= MIN_VOICE_S;
        voiced = 0;
        onState(mode === 'open' ? 'listening' : mode === 'wake' ? 'wake' : 'off');
        if (enough) void finish(got, rate); // too little voice: a cough, a door, a car
      }
      return;
    }
    ring.push(data);
    ringLen += data.length;
    while (ringLen - ring[0].length > PREROLL_S * rate) ringLen -= ring.shift()!.length;
    if (speech) {
      capture = [...ring];
      captureLen = ringLen;
      voiced = secs;
      ring = [];
      ringLen = 0;
      silence = 0;
      if (mode === 'open') onState('hearing');
    }
  }

  async function ensureMic() {
    if (stream) return;
    const h = await sidecarHealth();
    useWhisper = !!h?.speech && !h.mock;
    if (useWhisper) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = onAudio;
      src.connect(node);
      node.connect(ctx.destination); // required for onaudioprocess to fire; outputs silence
      return;
    }
    // Fallback: the browser's own recognition, kept running.
    const W = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) throw new Error('No speech recognition here');
    stream = new MediaStream(); // marker: "started"
    recog = new Ctor();
    recog.lang = 'en-GB';
    recog.continuous = true;
    recog.interimResults = false;
    recog.onresult = (e) => {
      if (mode === 'off' || isSpeaking() || performance.now() < quietUntil) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal && !isPhantom(r[0].transcript)) onUtterance(r[0].transcript.trim(), mode === 'open' ? 'open' : 'wake');
      }
    };
    recog.onerror = () => {};
    recog.onend = () => {
      if (mode !== 'off') {
        try {
          recog?.start();
        } catch {
          /* already running */
        }
      }
    };
    recog.start();
  }

  return {
    /** Listen for the next thing said (no wake word needed). */
    async listenOnce() {
      await ensureMic();
      void ctx?.resume();
      setMode('open');
    },
    /** Keep listening for "Hey Acuity" (during a walk). */
    async armWake(on: boolean) {
      wakeArmed = on;
      if (on) {
        await ensureMic();
        void ctx?.resume();
        if (mode !== 'open') setMode('wake');
      } else if (mode === 'wake') setMode('off');
    },
    /** Back to waiting for the wake word (or off) after an answer. */
    rest() {
      setMode(wakeArmed ? 'wake' : 'off');
    },
    stop() {
      wakeArmed = false;
      setMode('off');
      node?.disconnect();
      for (const t of stream?.getTracks() ?? []) t.stop();
      try {
        recog?.stop();
      } catch {
        /* not running */
      }
      void ctx?.close();
      stream = null;
      ctx = null;
      node = null;
      recog = null;
    },
    get mode() {
      return mode;
    },
  };
}

/** "hey acuity, what's around me" → "what's around me"; null when there is no wake word. */
export function afterWakeWord(text: string): string | null {
  const t = text.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  // Whisper's usual spellings of a new word: acuity, a cuity, equity, accuity, acuty…
  const m = t.match(/\b(?:(?:hey|hi|okay|ok|hello)\s+)?(?:acuity|a ?cuity|accuity|acuty|aquity|equity|acutie|acuity's|a\s?q\s?t)\b\s*(.*)$/);
  return m ? m[1].trim() : null;
}
