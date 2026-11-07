// Camera help by voice, with no screen to manage: Acuity opens the camera in
// the background, looks, answers, and closes it again.
//   readLight()     a few frames through Chenxi's detector → one steady reading
//   watchLight()    keep looking, report each steady change (until stopped)
//   lookAndAsk()    the sharpest frame to Abdullah's camera assistant
// Frames go only to the local service on this device (principle 8).

import { closeStream, grabFrame, sharpestFrame } from './camera';
import { createLightWatcher, readingOf, type Signal } from './lights';
import { makeSafe } from './safety';
import { askAssistant, detectLights } from './sidecar';

async function openHidden(): Promise<{ video: HTMLVideoElement; stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  // Let exposure settle: the first frames from a camera are often dark.
  await new Promise((r) => setTimeout(r, 500));
  return { video, stop: () => closeStream(stream) };
}

const SAY: Record<Signal, string> = {
  red: 'The traffic light ahead looks red.',
  amber: 'The traffic light ahead looks amber.',
  green: 'The traffic light ahead looks green. Check with your cane or dog and listen to the traffic.',
  mixed: 'I can see a red light and a green light. One may be for the traffic and one for you: I cannot tell which is yours.',
  unknown: "I can see a traffic light, but I can't tell which colour is lit.",
  none: "I can't see a traffic light. Point the phone across the road, at head height, and ask again.",
};

/** One answer about the light: the reading most frames agree on. */
export async function readLight(frames = 5): Promise<{ signal: Signal; sentence: string }> {
  const cam = await openHidden();
  try {
    const votes = new Map<Signal, number>();
    for (let i = 0; i < frames; i++) {
      const f = grabFrame(cam.video, 640, 0.8);
      if (f && f.brightness < 25) return { signal: 'none', sentence: "It's very dark, or the camera is covered." };
      if (f) {
        const s = readingOf(await detectLights(f.jpeg));
        votes.set(s, (votes.get(s) ?? 0) + 1);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    // A light seen in some frames beats "none" in others (a moving phone loses it now and then).
    const ranked = [...votes.entries()].sort((a, b) => (b[0] === 'none' ? -1 : 0) - (a[0] === 'none' ? -1 : 0) || b[1] - a[1]);
    const seen = ranked.find(([s]) => s !== 'none');
    const signal = seen && seen[1] >= 2 ? seen[0] : (ranked[0]?.[0] ?? 'none');
    return { signal, sentence: makeSafe(SAY[signal]) };
  } finally {
    cam.stop();
  }
}

/** Keep watching the light in the background; each steady change is reported. Returns stop(). */
export async function watchLight(onChange: (signal: Signal, sentence: string) => void, maxSeconds = 60): Promise<() => void> {
  const cam = await openHidden();
  let stopped = false;
  const watcher = createLightWatcher((s, sentence) => onChange(s, sentence));
  const stop = () => {
    stopped = true;
    cam.stop();
  };
  const until = performance.now() + maxSeconds * 1000;
  void (async () => {
    while (!stopped && performance.now() < until) {
      const f = grabFrame(cam.video, 640, 0.8);
      if (f && f.brightness >= 25) {
        try {
          watcher.feed(await detectLights(f.jpeg));
        } catch {
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!stopped) stop();
  })();
  return stop;
}

/** "What's in front of me?": the sharpest frame and the question, to Abdullah's camera assistant. */
export async function lookAndAsk(question: string): Promise<string> {
  const cam = await openHidden();
  try {
    const frame = await sharpestFrame(cam.video, 4, 120, 1920);
    const r = await askAssistant({ question, image: frame?.jpeg ?? null, speak: false });
    return makeSafe(r.answer);
  } finally {
    cam.stop();
  }
}
