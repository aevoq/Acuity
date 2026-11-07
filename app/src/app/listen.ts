// The main mic button: speech to text, then the same pipeline as typing.
// Abdullah's Whisper in the local service when it runs (offline); else the
// browser's own speech recognition (Chrome can do it on-device); else it says
// to type instead.

import { createRecorder } from '../vision/camera';
import { sidecarHealth, transcribeSpeech } from '../vision/sidecar';

type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onerror: (e: { error?: string }) => void;
  onend: () => void;
  start(): void;
  stop(): void;
};
type RecognitionCtor = new () => Recognition;

export interface Listener {
  /** Start listening. Resolves when listening has begun. */
  start(): Promise<void>;
  /** Stop, and get what was said ('' when nothing). */
  stop(): Promise<string>;
}

const browserRecognition = (): RecognitionCtor | null => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/** Pick the best way to listen right now, or null when there is none. */
export async function createListener(): Promise<{ listener: Listener; via: 'whisper' | 'browser' } | null> {
  const h = await sidecarHealth();
  if (h?.speech && !h.mock) {
    const rec = createRecorder();
    return {
      via: 'whisper',
      listener: {
        start: () => rec.start(),
        async stop() {
          const audio = await rec.stop();
          if (!audio) return '';
          return (await transcribeSpeech(audio)).text ?? '';
        },
      },
    };
  }
  const Ctor = browserRecognition();
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = 'en-GB';
  r.interimResults = false;
  r.maxAlternatives = 1;
  let heard = '';
  let ended: (() => void) | null = null;
  r.onresult = (e) => (heard = e.results[0]?.[0]?.transcript ?? '');
  r.onerror = () => ended?.();
  r.onend = () => ended?.();
  return {
    via: 'browser',
    listener: {
      async start() {
        heard = '';
        r.start();
      },
      stop() {
        return new Promise((resolve) => {
          ended = () => resolve(heard);
          r.stop();
          setTimeout(() => resolve(heard), 4000);
        });
      },
    },
  };
}
