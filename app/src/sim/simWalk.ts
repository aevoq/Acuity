// The simulated walk: a PositionSource that walks along a route's line at
// walking pace and emits a reading every second, with a little random jitter
// to imitate real GPS. Navigation can't tell it from real GPS, so the same
// guidance code works with navigator.geolocation later.
//
// Always label it "simulated walk" on screen.
//
//   const sim = createSimWalk(route.path, { speedFactor: 4 });
//   guidance = createGuidance({ route, source: sim, ... }); guidance.start(); sim.start();

import type { LatLng, Position, PositionSource } from '../contracts';
import { destination, pointAlong, polylineLength } from '../geo/geo';
import { WALKING_SPEED } from '../nav/router';

export interface SimWalkOptions {
  /** Metres per second at 1x. Default 1.4 (normal walking pace). */
  speed?: number;
  /** Demo speed-up: 1 = real time. */
  speedFactor?: number;
  /** Random GPS error in metres (0 = none). Default 3. */
  jitterMeters?: number;
  /** Reported accuracy, metres. Default 5. */
  accuracy?: number;
  /** Readings per real second. Default 1. */
  hz?: number;
  /**
   * Optional scripted problems, for testing the off-route and poor-GPS
   * prompts: between `from` and `to` metres along, push the position
   * `offsetMeters` sideways, or report `accuracy`.
   */
  incidents?: Array<{ from: number; to: number; offsetMeters?: number; accuracy?: number }>;
}

export interface SimWalk extends PositionSource {
  readonly kind: 'simulated';
  pause(): void;
  resume(): void;
  isRunning(): boolean;
  setSpeedFactor(f: number): void;
  /** Jump to a distance along the line (metres). */
  seek(meters: number): void;
  /** Metres walked so far, and the line's length. */
  progress(): { meters: number; total: number };
  /** Demo: walk `meters` to the side of the line (0 = back on it), to show the off-route warning. */
  setSidestep(meters: number): void;
  /** Demo: report this GPS accuracy (null = normal), to show the poor-GPS warning. */
  setAccuracy(meters: number | null): void;
}

export function createSimWalk(line: LatLng[], opts: SimWalkOptions = {}): SimWalk {
  const speed = opts.speed ?? WALKING_SPEED;
  let factor = opts.speedFactor ?? 1;
  const jitter = opts.jitterMeters ?? 3;
  const accuracy = opts.accuracy ?? 5;
  const hz = opts.hz ?? 1;
  const total = polylineLength(line);
  const listeners = new Set<(p: Position) => void>();
  let walked = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: Position | null = null;
  let sidestep = 0;
  let forcedAccuracy: number | null = null;

  const emitAt = (meters: number) => {
    const { point, bearing } = pointAlong(line, meters);
    const incident = opts.incidents?.find((i) => meters >= i.from && meters <= i.to);
    let p = point;
    const side = sidestep || incident?.offsetMeters || 0;
    if (side) p = destination(p, bearing + 90, side);
    if (jitter > 0) p = destination(p, Math.random() * 360, Math.random() * jitter);
    last = {
      lat: p.lat,
      lng: p.lng,
      accuracy: forcedAccuracy ?? incident?.accuracy ?? accuracy,
      heading: bearing,
      speed: speed,
      timestamp: Date.now(),
      source: 'simulated',
    };
    for (const l of listeners) l(last);
  };

  const tick = () => {
    walked = Math.min(total, walked + (speed * factor) / hz);
    emitAt(walked);
    if (walked >= total) pause();
  };

  function pause() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    kind: 'simulated',
    start() {
      if (timer) return;
      if (walked >= total) walked = 0;
      emitAt(walked);
      timer = setInterval(tick, 1000 / hz);
    },
    stop() {
      pause();
      walked = 0;
    },
    pause,
    resume() {
      if (!timer && walked < total) timer = setInterval(tick, 1000 / hz);
    },
    isRunning: () => timer != null,
    setSpeedFactor(f) {
      factor = Math.max(0.25, Math.min(20, f));
    },
    seek(m) {
      walked = Math.max(0, Math.min(total, m));
      emitAt(walked);
    },
    progress: () => ({ meters: walked, total }),
    setSidestep(m) {
      sidestep = m;
    },
    setAccuracy(m) {
      forcedAccuracy = m;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => last,
  };
}
