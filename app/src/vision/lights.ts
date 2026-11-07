// Turns Chenxi's per-frame traffic-light readings into calm, spoken updates.
// A reading must hold for 2 of the last 3 frames before it is announced, so a
// single bad frame never flips the answer. Advisory only (principle 1): it
// reports what the camera sees, never whether it is safe to cross.

import type { Detection } from './sidecar';
import { makeSafe } from './safety';

export type Signal = 'red' | 'amber' | 'green' | 'mixed' | 'unknown' | 'none';

export const SIGNAL_WORDS: Record<Signal, string> = {
  red: 'Red',
  amber: 'Amber',
  green: 'Green',
  mixed: 'Red and green both lit',
  unknown: 'Light, colour unclear',
  none: 'No light seen',
};

const SAY: Record<Signal, string> = {
  red: 'The traffic light looks red.',
  amber: 'The traffic light looks amber.',
  green: 'The traffic light looks green. Check with your cane or dog and listen to the traffic.',
  // At a pelican crossing the traffic lights show red while the green man is lit:
  // with both in view we cannot tell which one is yours, so we say exactly that.
  mixed: 'I can see a red light and a green light. One may be for the traffic and one for you: I cannot tell which is yours.',
  unknown: "I can see a traffic light, but I can't tell which colour is lit.",
  none: "I can't see a traffic light. Point the camera across the road, at head height.",
};

/** Lights this sure count as "seen" when deciding between colours. */
const SURE = 0.5;

/** One frame's reading: the most confident light, or "mixed" when confident lights disagree, or none. */
export function readingOf(d: Detection): Signal {
  if (!d.lights.length) return 'none';
  const sure = new Set(d.lights.filter((l) => l.confidence >= SURE && l.colour !== 'unknown').map((l) => l.colour));
  if ((sure.has('red') || sure.has('amber')) && sure.has('green')) return 'mixed';
  return [...d.lights].sort((a, b) => b.confidence - a.confidence)[0].colour;
}

export function createLightWatcher(onChange: (signal: Signal, sentence: string) => void) {
  const last: Signal[] = [];
  let stable: Signal | null = null;
  let first = true;
  return {
    feed(d: Detection): Signal | null {
      last.push(readingOf(d));
      if (last.length > 3) last.shift();
      const counts = new Map<Signal, number>();
      for (const s of last) counts.set(s, (counts.get(s) ?? 0) + 1);
      const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (n >= 2 && top !== stable) {
        stable = top;
        const lead = first ? 'Camera check, a guide only. ' : '';
        first = false;
        onChange(top, makeSafe(lead + SAY[top]));
      }
      return stable;
    },
    reset() {
      last.length = 0;
      stable = null;
      first = true;
    },
    get current() {
      return stable;
    },
  };
}
