// Walking guidance (F2): watches a PositionSource and says the right thing at
// the right moment. It never reads GPS itself, so the simulated walk and real
// GPS drive it identically.
//
//   const g = createGuidance({ route, source, onSpeak: (req) => voice.speak(req) });
//   g.start();   // speaks the start instruction, then follows positions
//   g.nextStep() // "What do I do next?" (F4)
//   g.stop();
//
// Rules from the PRD:
//   - each waypoint is spoken when the user comes within its trigger radius;
//   - reassurance every N metres: "Still on route, 120 metres to the next turn";
//   - off-route: more than 25 m from the route line for 3 readings in a row;
//   - poor GPS: accuracy worse than 30 m is said, not guessed through.

import type { LatLng, Position, PositionSource, Route, SpeakRequest, Waypoint } from '../contracts';
import { distance, distanceToSegment } from '../geo/geo';

export const OFF_ROUTE_METERS = 25;
export const OFF_ROUTE_READINGS = 3;
export const BACK_ON_ROUTE_METERS = 15;
export const POOR_GPS_METERS = 30;
export const GOOD_GPS_METERS = 20;

export interface GuidanceState {
  progressMeters: number;
  remainingMeters: number;
  /** Distance from the route line at the last good reading. */
  offsetMeters: number;
  next: Waypoint | null;
  offRoute: boolean;
  poorGps: boolean;
  arrived: boolean;
  lastPosition: Position | null;
}

export interface GuidanceOptions {
  route: Route;
  source: PositionSource;
  onSpeak: (req: SpeakRequest) => void;
  onState?: (s: GuidanceState) => void;
  /** Fired once each time the user goes off route; the app offers a reroute. */
  onOffRoute?: (at: Position) => void;
  /** Reassurance every N metres of walking with nothing else said. 0 = off. */
  reassuranceEveryMeters?: number;
}

export interface Guidance {
  start(): void;
  stop(): void;
  state(): GuidanceState;
  /** The instruction for the next waypoint, for "what do I do next?". */
  nextStep(): string;
  /** The last thing spoken, for "say that again". */
  lastPrompt(): string | null;
}

/** Where a point projects onto the route line: distance along it and distance off it. */
function projectOnto(path: LatLng[], cum: number[], p: LatLng, hintSeg: number): { along: number; offset: number; seg: number } {
  let best = { along: 0, offset: Infinity, seg: hintSeg };
  // Search a window ahead of where we were (and a little behind), so a route
  // that doubles back on itself doesn't snap to the wrong leg.
  const lo = Math.max(1, hintSeg - 3);
  const hi = Math.min(path.length - 1, hintSeg + 60);
  for (let i = lo; i <= hi; i++) {
    const { meters, t } = distanceToSegment(p, path[i - 1], path[i]);
    if (meters < best.offset) best = { along: cum[i - 1] + t * (cum[i] - cum[i - 1]), offset: meters, seg: i };
  }
  return best;
}

const roundTo = (m: number, step = 10) => Math.max(step, Math.round(m / step) * step);

/** Order for waypoints said together: safety-relevant first. */
const rank = (w: Waypoint) => ({ crossing: 0, turn: 1, bench: 2, landmark: 3, busStop: 4, arrive: 5, start: 6 })[w.kind];

export function createGuidance(opts: GuidanceOptions): Guidance {
  const { route, source, onSpeak, onState, onOffRoute } = opts;
  const every = opts.reassuranceEveryMeters ?? 100;
  const path = route.path;
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distance(path[i - 1], path[i]));
  const total = cum[cum.length - 1];

  const done = new Set<string>();
  let seg = 1;
  let progress = 0;
  let offCount = 0;
  let lastSpokenAt = 0; // progress (m) when we last said anything
  let last: string | null = null;
  let unsub: (() => void) | null = null;
  const st: GuidanceState = {
    progressMeters: 0,
    remainingMeters: total,
    offsetMeters: 0,
    next: route.waypoints[0] ?? null,
    offRoute: false,
    poorGps: false,
    arrived: false,
    lastPosition: null,
  };

  const say = (req: SpeakRequest) => {
    last = req.text;
    lastSpokenAt = progress;
    onSpeak(req);
  };
  const nextWaypoint = () => route.waypoints.find((w) => !done.has(w.id) && w.kind !== 'start') ?? null;
  const emit = () => {
    st.progressMeters = Math.round(progress);
    st.remainingMeters = Math.max(0, Math.round(total - progress));
    st.next = nextWaypoint();
    onState?.({ ...st });
  };

  function onPosition(p: Position) {
    if (st.arrived) return;
    st.lastPosition = p;

    // Poor GPS: say so once, and don't act on bad fixes.
    if (p.accuracy > POOR_GPS_METERS) {
      if (!st.poorGps) {
        st.poorGps = true;
        say({ text: `GPS is poor right now, accurate to about ${roundTo(p.accuracy)} metres. I'll wait for a better signal before the next instruction.`, priority: 'interrupt' });
      }
      emit();
      return;
    }
    if (st.poorGps && p.accuracy <= GOOD_GPS_METERS) {
      st.poorGps = false;
      say({ text: 'GPS is good again.' });
    }
    if (st.poorGps) return emit();

    const proj = projectOnto(path, cum, p, seg);
    st.offsetMeters = Math.round(proj.offset);

    // Off route: 3 readings in a row more than 25 m away.
    if (proj.offset > OFF_ROUTE_METERS) {
      offCount++;
      if (offCount >= OFF_ROUTE_READINGS && !st.offRoute) {
        st.offRoute = true;
        say({ text: `You are off the route, about ${roundTo(proj.offset)} metres from it. Say "reroute" for a new route from here.`, milestone: 'offRoute', priority: 'interrupt' });
        onOffRoute?.(p);
      }
      return emit();
    }
    offCount = 0;
    if (st.offRoute && proj.offset <= BACK_ON_ROUTE_METERS) {
      st.offRoute = false;
      say({ text: 'Back on the route.' });
    }

    // Progress only moves forward (GPS jitter must not replay a turn).
    if (proj.along >= progress - 5) {
      progress = Math.max(progress, proj.along);
      seg = proj.seg;
    }

    // Waypoints we have reached. Ones already well behind us (a GPS jump) are
    // dropped so the user isn't read a backlog; ones at the same spot (a
    // crossing right at a turn) are said together, crossing first.
    const due = route.waypoints.filter((w) => !done.has(w.id) && w.kind !== 'start' && progress >= w.distanceAlong - w.triggerRadius);
    if (due.length) {
      for (const w of due) done.add(w.id);
      const latest = due[due.length - 1];
      const now = due.filter((w) => latest.distanceAlong - w.distanceAlong <= 10);
      const arrive = now.find((w) => w.kind === 'arrive');
      if (arrive) st.arrived = true;
      const ordered = [...now].sort((a, b) => rank(a) - rank(b));
      const text = ordered.map((w, i) => (i === 0 ? w.instruction : w.instruction.replace(/^In about \d+ metres, /, 'Then ').replace(/^Then (\w)/, (_m, c) => `Then ${c}`))).join(' ');
      const milestone = (arrive ?? ordered[0]).milestone ?? undefined;
      say({ text, milestone, priority: arrive ? 'queue' : 'interrupt' });
      if (st.arrived) {
        emit();
        stop();
        return;
      }
    } else if (every > 0 && progress - lastSpokenAt >= every) {
      // Reassurance, unless the next instruction is about to be said anyway.
      const nx = nextWaypoint();
      const toNext = nx ? Math.max(0, nx.distanceAlong - progress) : total - progress;
      if (toNext < 60) return emit();
      const what = !nx || nx.kind === 'arrive' ? 'your destination' : nx.kind === 'crossing' ? 'the next crossing' : nx.kind === 'bench' ? 'the next bench' : 'the next turn';
      say({ text: `Still on route. ${roundTo(toNext)} metres to ${what}.` });
    }
    emit();
  }

  function stop() {
    unsub?.();
    unsub = null;
  }

  return {
    start() {
      if (unsub) return;
      const startWp = route.waypoints.find((w) => w.kind === 'start');
      if (startWp) {
        done.add(startWp.id);
        // The person just pressed Start: say it now, over anything still playing.
        say({ text: startWp.instruction, priority: 'interrupt' });
      }
      unsub = source.subscribe(onPosition);
      emit();
    },
    stop,
    state: () => ({ ...st }),
    nextStep() {
      if (st.arrived) return `You have arrived at ${route.destinationName}.`;
      const nx = nextWaypoint();
      if (!nx) return 'There are no more instructions on this route.';
      const toNext = Math.max(0, nx.distanceAlong - progress);
      // Restate with the real distance instead of the trigger distance.
      return nx.instruction.replace(/^In about \d+ metres/, `In about ${roundTo(toNext)} metres`);
    },
    lastPrompt: () => last,
  };
}
