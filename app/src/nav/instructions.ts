// Turn the route's geometry into spoken waypoints (F2, ADR-003 consequence).
//
// - Turns: detected from the change in bearing where one edge meets the next.
//   Only announced where there is a real choice (3+ ways meet) or the path
//   bends sharply.
// - Crossings: every road crossing on the route, with what the pack knows
//   (signals, tactile paving, kerb).
// - Benches: on the rest-stops profile, benches within 20 m of the route.
// - Start and arrival.
//
// Every word comes from pack data: street names, place names, OSM tags.
// Nothing is invented (principle 2).

import type { CrossingInfo, GraphEdge, LatLng, Milestone, Route, RouteProfileId, Waypoint } from '../contracts';
import { bearing, distance, pointAlong, turnAngle } from '../geo/geo';
import type { PackIndex } from '../pack/pack';
import { crossingAt } from './costs';

const TURN_TRIGGER = 15; // metres before the turn
const CROSSING_TRIGGER = 15;
const BENCH_TRIGGER = 20;
const ARRIVE_TRIGGER = 10;

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compassWord = (deg: number) => COMPASS[Math.round(deg / 45) % 8];

/** Material Symbols icon for a turn angle (degrees, positive = right). */
export function turnIcon(t: number): string {
  const a = Math.abs(t);
  const side = t > 0 ? 'right' : 'left';
  if (a < 30) return 'straight';
  if (a < 60) return `turn_slight_${side}`;
  if (a < 135) return `turn_${side}`;
  if (a < 165) return `turn_sharp_${side}`;
  return 'u_turn_left';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function turnWords(t: number): string | null {
  const a = Math.abs(t);
  const side = t > 0 ? 'right' : 'left';
  if (a < 30) return null;
  if (a < 60) return `bear ${side}`;
  if (a < 135) return `turn ${side}`;
  if (a < 165) return `turn sharp ${side}`;
  return 'turn back on yourself';
}

export function describeCrossing(c: CrossingInfo): { text: string; milestone: Milestone; icon: string; title: string; detail: string } {
  const kind =
    c.type === 'traffic_signals' ? 'a crossing with traffic signals'
    : c.type === 'zebra' ? 'a zebra crossing'
    : c.type === 'marked' ? 'a marked crossing'
    : c.type === 'uncontrolled' ? 'an uncontrolled crossing, with no signals'
    : 'a road crossing';
  const extras: string[] = [];
  if (c.tactilePaving === true) extras.push('tactile paving');
  if (c.kerb === 'lowered' || c.kerb === 'flush') extras.push('a dropped kerb');
  if (c.kerb === 'raised') extras.push('a raised kerb');
  const text = `In about ${CROSSING_TRIGGER} metres, ${kind}${extras.length ? `, with ${extras.join(' and ')}` : ''}.`;
  const accessible = c.type === 'traffic_signals' || c.tactilePaving === true;
  const title =
    c.type === 'traffic_signals' ? 'Crossing with signals'
    : c.type === 'zebra' ? 'Zebra crossing'
    : c.type === 'marked' ? 'Marked crossing'
    : c.type === 'uncontrolled' ? 'Crossing, no signals'
    : 'Road crossing';
  const detail = extras.length ? cap(extras.join(', ').replace(/\ba /g, '')) : 'No tactile paving recorded';
  return { text, milestone: accessible ? 'crossingAccessible' : 'crossingAhead', icon: c.type === 'traffic_signals' ? 'traffic' : 'directions_walk', title, detail };
}

/** Cumulative distance at each vertex of a polyline. */
function cumulative(path: LatLng[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + distance(path[i - 1], path[i]));
  return out;
}

/** Distance along the path of the vertex nearest `p`, searching forward from `fromIdx`. */
function locate(path: LatLng[], cum: number[], p: LatLng, fromIdx: number): { along: number; idx: number } {
  let best = fromIdx;
  let bestD = Infinity;
  for (let i = fromIdx; i < path.length; i++) {
    const d = distance(p, path[i]);
    if (d < bestD) [best, bestD] = [i, d];
    if (d < 0.5) break;
  }
  return { along: cum[best], idx: best };
}

/** A point `meters` back from / ahead of distance `along` on the path, for stable bearings. */
function bearingAround(path: LatLng[], along: number, span = 10) {
  const before = pointAlong(path, Math.max(0, along - span)).point;
  const at = pointAlong(path, along).point;
  const after = pointAlong(path, along + span).point;
  return { inB: bearing(before, at), outB: bearing(at, after) };
}

export function buildWaypoints(
  route: Route,
  steps: Array<{ edge: GraphEdge; from: string }>,
  index: PackIndex,
  profile: RouteProfileId,
): Waypoint[] {
  const { path } = route;
  const cum = cumulative(path);
  const total = cum[cum.length - 1];
  const wps: Waypoint[] = [];
  let n = 0;
  type Display = { icon: string; title: string; detail: string };
  const add = (kind: Waypoint['kind'], at: LatLng, along: number, triggerRadius: number, instruction: string, milestone: Milestone | null, show: Display) =>
    wps.push({ id: `wp${n++}`, kind, lat: at.lat, lng: at.lng, triggerRadius, instruction, distanceAlong: Math.round(along), milestone, ...show });

  // --- start
  // Only name the street if the route actually starts on it (within ~30 m).
  let firstStreet: string | null = null;
  for (let i = 0, run = 0; i < steps.length && run <= 30; run += steps[i].edge.length, i++) {
    if (steps[i].edge.name) {
      firstStreet = steps[i].edge.name;
      break;
    }
  }
  const head = path.length > 1 ? compassWord(bearing(path[0], pointAlong(path, 15).point)) : null;
  const mins = Math.max(1, Math.round(route.durationSeconds / 60));
  add(
    'start',
    path[0],
    0,
    0,
    `Route to ${route.destinationName}: ${Math.round(total / 10) * 10} metres, about ${mins} minute${mins === 1 ? '' : 's'}.` +
      (head ? ` Head ${head}${firstStreet ? ` along ${firstStreet}` : ''}.` : ''),
    null,
    { icon: 'straight', title: head ? `Head ${head}` : 'Start', detail: firstStreet ? `on ${firstStreet}` : 'along the path' },
  );

  // --- turns and crossings, junction by junction
  let searchFrom = 0;
  let lastTurnAlong = -Infinity;
  for (let i = 0; i < steps.length; i++) {
    const { edge, from } = steps[i];
    const toId = index.otherEnd(edge, from);
    const fromNode = index.node(from)!;
    const toNode = index.node(toId)!;
    const { along, idx } = locate(path, cum, toNode, searchFrom);
    searchFrom = idx;

    // Crossing at the end of this edge (or along it, for a crossing way).
    const c = crossingAt(edge, fromNode, toNode);
    if (c) {
      const at = toNode.crossing ? toNode : pointAlong(path, Math.max(0, along - edge.length / 2)).point;
      const where = toNode.crossing ? along : Math.max(0, along - edge.length / 2);
      const { text, milestone, icon, title, detail } = describeCrossing(c);
      add('crossing', at, where, CROSSING_TRIGGER, text, milestone, { icon, title, detail });
    }

    // Turn onto the next edge?
    const next = steps[i + 1];
    if (!next || along < 5 || total - along < 8) continue;
    const { inB, outB } = bearingAround(path, along);
    const t = turnAngle(inB, outB);
    const words = turnWords(t);
    if (!words) continue;
    const degree = index.edgesAt(toId).length;
    if (degree < 3 && Math.abs(t) < 75) continue; // a gentle bend with no other way to go
    const onto = next.edge.name && next.edge.name !== edge.name ? ` onto ${next.edge.name}` : '';
    const landmark = index.placesNear(toNode, 25, 1)[0]?.place;
    const near = landmark ? `, at ${landmark.name}` : '';
    const verb = degree < 3 ? `the path bends ${t > 0 ? 'right' : 'left'}` : words;

    // Two turns within 12 m: say them together.
    const prev = wps[wps.length - 1];
    // At most two turns per sentence; a third starts a new waypoint.
    if (prev && prev.kind === 'turn' && along - lastTurnAlong < 12 && !prev.instruction.includes('then immediately')) {
      prev.instruction = prev.instruction.replace(/\.$/, `, then immediately ${verb.replace(/^turn /, '')}${onto}.`);
      prev.detail = `then immediately ${verb.replace(/^turn /, '')}${onto}`;
      lastTurnAlong = along;
      continue;
    }
    add('turn', toNode, along, TURN_TRIGGER, `In about ${TURN_TRIGGER} metres, ${verb}${onto}${near}.`, 'turnAhead', {
      icon: turnIcon(t),
      title: cap(verb),
      detail: onto ? onto.trim() + (landmark ? `, at ${landmark.name}` : '') : landmark ? `at ${landmark.name}` : 'onto the footpath',
    });
    lastTurnAlong = along;
  }

  // --- benches (rest-stops profile, F10)
  if (profile === 'restStops') {
    let lastBench = -Infinity;
    const candidates = index.pack.benches
      .map((b) => ({ b, ...locate(path, cum, b, 0), d: 0 }))
      .map((c) => ({ ...c, d: distance(c.b, path[c.idx]) }))
      .filter((c) => c.d <= 20)
      .sort((a, b) => a.along - b.along);
    for (const c of candidates) {
      if (c.along - lastBench < 150) continue;
      add('bench', c.b, c.along, BENCH_TRIGGER, 'A bench nearby, if you want to rest.', 'benchNearby', { icon: 'chair', title: 'Bench', detail: 'A place to rest' });
      lastBench = c.along;
    }
  }

  // --- arrival
  add('arrive', path[path.length - 1], total, ARRIVE_TRIGGER, `You have arrived at ${route.destinationName}.`, 'arrived', {
    icon: 'flag',
    title: `Arrive at ${route.destinationName}`,
    detail: 'Destination',
  });

  return wps.sort((a, b) => a.distanceAlong - b.distanceAlong);
}
