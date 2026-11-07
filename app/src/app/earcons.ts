// The sound and vibration language for milestones (PRD F5). One short,
// distinct sound per milestone, played just before the words, quiet enough
// that traffic stays audible. Phones that support it also vibrate (Android;
// iPhone browsers cannot vibrate a web page). Made with Web Audio, so there
// are no files and it works offline.

import type { Milestone } from '../contracts';

type Note = { f: number; t: number; d: number; type?: OscillatorType; v?: number };

/** Each milestone's notes: frequency (Hz), start (s), duration (s). From the PRD's table. */
const SOUNDS: Record<Milestone | 'listen' | 'listenEnd', Note[]> = {
  turnAhead: [{ f: 660, t: 0, d: 0.11 }, { f: 880, t: 0.13, d: 0.13 }], //               rising two-note
  crossingAhead: [{ f: 950, t: 0, d: 0.05, type: 'triangle' }, { f: 750, t: 0.18, d: 0.05, type: 'triangle' }], // soft tick-tock
  crossingAccessible: [{ f: 1400, t: 0, d: 0.05, type: 'triangle' }, { f: 1150, t: 0.18, d: 0.05, type: 'triangle' }], // higher tick-tock
  benchNearby: [{ f: 392, t: 0, d: 0.45, v: 0.18 }], //                                  low chime
  busStopPassed: [{ f: 1200, t: 0, d: 0.04, type: 'square', v: 0.08 }], //              single click
  yourStopNext: [{ f: 880, t: 0, d: 0.12 }, { f: 1108, t: 0.15, d: 0.12 }, { f: 1319, t: 0.3, d: 0.18 }], // three-note alert
  offRoute: [{ f: 170, t: 0, d: 0.35, type: 'sawtooth', v: 0.1 }], //                    low buzz
  arrived: [{ f: 523, t: 0, d: 0.12 }, { f: 659, t: 0.13, d: 0.12 }, { f: 784, t: 0.26, d: 0.12 }, { f: 1047, t: 0.39, d: 0.28 }], // short melody
  listen: [{ f: 740, t: 0, d: 0.08 }, { f: 988, t: 0.09, d: 0.1 }], //                   microphone on
  listenEnd: [{ f: 988, t: 0, d: 0.08 }, { f: 740, t: 0.09, d: 0.1 }], //                microphone off
};

/** Vibration patterns (ms on, off, on…), from the PRD's haptic column. */
const BUZZ: Partial<Record<Milestone, number[]>> = {
  turnAhead: [60, 80, 60],
  crossingAhead: [400],
  crossingAccessible: [400, 100, 80],
  busStopPassed: [60],
  yourStopNext: [150, 100, 150, 100, 150],
  offRoute: [200, 100, 200, 100, 200],
  arrived: [80, 60, 80, 60, 250],
};

/** What each sound means, for "Learn the sounds" in Settings. */
export const SOUND_NAMES: Record<Milestone, string> = {
  turnAhead: 'Turn coming up',
  crossingAhead: 'Crossing ahead',
  crossingAccessible: 'Crossing with signals or tactile paving',
  benchNearby: 'Bench nearby',
  busStopPassed: 'Bus stop passed',
  yourStopNext: 'Your stop is next',
  offRoute: 'Off route',
  arrived: 'Arrived',
};

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Play one earcon; resolves when it has finished (so the words come after it). */
export function playEarcon(name: Milestone | 'listen' | 'listenEnd', volume = 1): Promise<void> {
  const notes = SOUNDS[name];
  const a = audio();
  if (!a || !notes) return Promise.resolve();
  const now = a.currentTime + 0.02;
  let end = 0;
  for (const n of notes) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = n.type ?? 'sine';
    osc.frequency.value = n.f;
    const peak = (n.v ?? 0.14) * volume;
    // Short attack and release: no clicks, and quiet enough to hear traffic over.
    gain.gain.setValueAtTime(0, now + n.t);
    gain.gain.linearRampToValueAtTime(peak, now + n.t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.t + n.d);
    osc.connect(gain).connect(a.destination);
    osc.start(now + n.t);
    osc.stop(now + n.t + n.d + 0.02);
    end = Math.max(end, n.t + n.d);
  }
  return new Promise((r) => setTimeout(r, (end + 0.08) * 1000));
}

/** Vibrate for a milestone, where the device can. */
export function buzz(name: Milestone) {
  const p = BUZZ[name];
  if (p && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(p);
    } catch {
      // not allowed here (no user gesture yet): skip
    }
  }
}
