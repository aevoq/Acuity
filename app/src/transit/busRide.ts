// Bus stop countdown (F8): the phone announces stops whether or not the bus
// does. Works offline: the route's stop list and positions are in the pack,
// and GPS needs no data connection.
//
//   const ride = createBusRide({ index, route, from: boardStopId, to: alightStopId, source, onSpeak });
//   ride.start();
//
// Each stop passed: a click and a tap ("busStopPassed") with how many are left.
// One stop before yours: the three-note alert ("yourStopNext"), so there is
// time to ring the bell and move to the door. At your stop: "arrived".

import type { BusRoute, BusStop, LatLng, Position, PositionSource, SpeakRequest } from '../contracts';
import { distance, distanceToSegment } from '../geo/geo';
import type { PackIndex } from '../pack/pack';

/** A stop counts as passed this many metres before reaching it (GPS lag, bus speed). */
const PASS_EARLY = 20;

export interface BusRidePlan {
  route: BusRoute;
  stops: BusStop[];
  /** Straight lines stop to stop: good enough to measure progress between stops. */
  line: LatLng[];
}

/** The stops from `fromId` to `toId` along a route, or null if the route doesn't go that way. */
export function planBusRide(index: PackIndex, route: BusRoute, fromId: string, toId: string): BusRidePlan | null {
  const i = route.stops.indexOf(fromId);
  const j = route.stops.indexOf(toId);
  if (i < 0 || j <= i) return null;
  const byId = new Map(index.pack.busStops.map((s) => [s.id, s]));
  const stops = route.stops.slice(i, j + 1).map((id) => byId.get(id)).filter((s): s is BusStop => !!s);
  if (stops.length < 2) return null;
  return { route, stops, line: stops.map((s) => ({ lat: s.lat, lng: s.lng })) };
}

export interface BusRideState {
  /** Index into plan.stops of the last stop passed (0 = boarding stop). */
  passed: number;
  stopsLeft: number;
  nextStop: BusStop | null;
  arrived: boolean;
}

export interface BusRideOptions {
  plan: BusRidePlan;
  source: PositionSource;
  onSpeak: (req: SpeakRequest) => void;
  onState?: (s: BusRideState) => void;
  /** Warn this many stops before yours. Default 1 (PRD: "one stop early"). */
  warnStopsBefore?: number;
}

export function createBusRide({ plan, source, onSpeak, onState, warnStopsBefore = 1 }: BusRideOptions) {
  const { stops, line, route } = plan;
  const cum = [0];
  for (let k = 1; k < line.length; k++) cum.push(cum[k - 1] + distance(line[k - 1], line[k]));
  const last = stops.length - 1;
  const alight = stops[last];

  let passed = 0;
  let progress = 0;
  let warned = false;
  let unsub: (() => void) | null = null;
  const state = (): BusRideState => ({ passed, stopsLeft: last - passed, nextStop: stops[passed + 1] ?? null, arrived: passed >= last });

  const stopName = (s: BusStop) => [s.name, s.indicator].filter(Boolean).join(', ');

  function onPosition(p: Position) {
    if (passed >= last) return;
    // Progress along the stop-to-stop line, only forwards.
    let best = { along: progress, d: Infinity };
    for (let k = Math.max(1, passed); k <= Math.min(last, passed + 3); k++) {
      const { meters, t } = distanceToSegment(p, line[k - 1], line[k]);
      if (meters < best.d) best = { along: cum[k - 1] + t * (cum[k] - cum[k - 1]), d: meters };
    }
    progress = Math.max(progress, best.along);

    while (passed < last && progress >= cum[passed + 1] - PASS_EARLY) {
      passed++;
      const left = last - passed;
      if (passed === last) {
        onSpeak({ text: `This is your stop: ${stopName(alight)}.`, milestone: 'arrived', priority: 'interrupt' });
        unsub?.();
        unsub = null;
      } else if (left <= warnStopsBefore && !warned) {
        warned = true;
        onSpeak({ text: `Your stop, ${alight.name}, is next. Ring the bell now.`, milestone: 'yourStopNext', priority: 'interrupt' });
      } else {
        onSpeak({ text: `${stops[passed].name}. ${left} stop${left === 1 ? '' : 's'} to go.`, milestone: 'busStopPassed' });
      }
    }
    onState?.(state());
  }

  return {
    start() {
      if (unsub) return;
      const n = last;
      onSpeak({ text: `Bus ${route.name} towards ${route.destination ?? 'its destination'}. ${n} stop${n === 1 ? '' : 's'} to ${alight.name}. I'll tell you as each stop passes.` });
      unsub = source.subscribe(onPosition);
      onState?.(state());
    },
    stop() {
      unsub?.();
      unsub = null;
    },
    state,
  };
}
