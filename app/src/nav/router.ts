// A* router over the area pack's walking graph (ADR-003). Runs offline, in a
// few milliseconds for the ~20,000-edge UCL East pack.
//
// A* = Dijkstra's shortest path plus a guess (straight-line distance to the
// goal) that tells it which way to explore first. Same answer, fewer edges.
//
//   const router = createRouter(index);
//   const route = router.route(start, place, 'fewestCrossings', 'Tesco Express');
//   route.tradeOff  // "Fewest crossings route: 2 minutes longer, 3 fewer crossings."

import type { GraphEdge, LatLng, Route, RouteProfileId } from '../contracts';
import { distance, makeProjection } from '../geo/geo';
import type { PackIndex } from '../pack/pack';
import { crossingAt, edgeCost, PROFILE_LABELS, type CostContext } from './costs';
import { buildWaypoints } from './instructions';

export const WALKING_SPEED = 1.4; // metres per second

/** Minimal binary min-heap keyed by number. */
class MinHeap<T> {
  private items: Array<{ k: number; v: T }> = [];
  get size() {
    return this.items.length;
  }
  push(k: number, v: T) {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0].v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Edges with a bench within `radius` metres of any point on them. */
function edgesNearBenches(index: PackIndex, radius = 25): Set<string> {
  const { pack } = index;
  const proj = makeProjection(pack.center);
  const cell = 50;
  const grid = new Map<string, Array<{ x: number; y: number }>>();
  for (const b of pack.benches) {
    const p = proj.toXY(b);
    const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  const near = new Set<string>();
  for (const e of pack.edges) {
    const pts = index.edgeLine(e, e.from).map((p) => proj.toXY(p));
    search: for (const p of pts) {
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor(p.y / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const b of grid.get(`${cx + dx},${cy + dy}`) ?? [])
            if (Math.hypot(b.x - p.x, b.y - p.y) <= radius) {
              near.add(e.id);
              break search;
            }
    }
  }
  return near;
}

export interface Router {
  /** Lowest-cost route, or null when the destination cannot be reached under this profile. */
  route(from: LatLng, to: LatLng, profile: RouteProfileId, destinationName: string): Route | null;
  /** Walking distance in metres (shortest profile), or null if unreachable. Used to rank "nearest X". */
  walkingDistance(from: LatLng, to: LatLng): number | null;
}

export function createRouter(index: PackIndex): Router {
  const ctx: CostContext = { nearBench: edgesNearBenches(index) };

  /** A* from node to node. Returns the edges in order, or null. */
  function search(startId: string, goalId: string, profile: RouteProfileId): Array<{ edge: GraphEdge; from: string }> | null {
    if (startId === goalId) return [];
    const goal = index.node(goalId)!;
    const best = new Map<string, number>([[startId, 0]]);
    const came = new Map<string, { edge: GraphEdge; from: string }>();
    const open = new MinHeap<string>();
    open.push(distance(index.node(startId)!, goal), startId);
    const closed = new Set<string>();

    while (open.size) {
      const id = open.pop()!;
      if (id === goalId) break;
      if (closed.has(id)) continue;
      closed.add(id);
      const here = index.node(id)!;
      const g = best.get(id)!;
      for (const edge of index.edgesAt(id)) {
        const nextId = index.otherEnd(edge, id);
        if (closed.has(nextId)) continue;
        const next = index.node(nextId)!;
        const c = edgeCost(profile, edge, here, next, ctx);
        if (!Number.isFinite(c)) continue;
        const ng = g + c;
        if (ng < (best.get(nextId) ?? Infinity)) {
          best.set(nextId, ng);
          came.set(nextId, { edge, from: id });
          open.push(ng + distance(next, goal), nextId);
        }
      }
    }
    if (!came.has(goalId)) return null;
    const steps: Array<{ edge: GraphEdge; from: string }> = [];
    for (let id = goalId; id !== startId; ) {
      const step = came.get(id)!;
      steps.push(step);
      id = step.from;
    }
    return steps.reverse();
  }

  function build(from: LatLng, to: LatLng, profile: RouteProfileId, destinationName: string): Route | null {
    const start = index.nearestNode(from).node;
    const goal = index.nearestNode(to).node;
    const steps = search(start.id, goal.id, profile);
    if (!steps) return null;

    // Geometry: from the exact start, along every edge, to the exact destination.
    const path: LatLng[] = [{ lat: from.lat, lng: from.lng }];
    let crossings = 0;
    let signalled = 0;
    for (const { edge, from: fromId } of steps) {
      const line = index.edgeLine(edge, fromId);
      path.push(...line.slice(path.length > 1 ? 1 : 0));
      const c = crossingAt(edge, index.node(fromId)!, index.node(index.otherEnd(edge, fromId))!);
      if (c) {
        crossings++;
        if (c.type === 'traffic_signals') signalled++;
      }
    }
    if (steps.length === 0) path.push({ lat: start.lat, lng: start.lng });
    path.push({ lat: to.lat, lng: to.lng });
    // Drop consecutive duplicates (the snapped start/end can sit on a node).
    const clean = path.filter((p, i) => i === 0 || distance(p, path[i - 1]) > 0.5);

    let length = 0;
    for (let i = 1; i < clean.length; i++) length += distance(clean[i - 1], clean[i]);

    const route: Route = {
      profile,
      from,
      to,
      destinationName,
      path: clean,
      edgeIds: steps.map((s) => s.edge.id),
      lengthMeters: Math.round(length),
      durationSeconds: Math.round(length / WALKING_SPEED),
      crossings,
      signalledCrossings: signalled,
      waypoints: [],
      tradeOff: null,
    };
    route.waypoints = buildWaypoints(route, steps, index, profile);
    return route;
  }

  return {
    route(from, to, profile, destinationName) {
      const r = build(from, to, profile, destinationName);
      if (!r || profile === 'shortest') return r;
      const base = build(from, to, 'shortest', destinationName);
      if (base) r.tradeOff = describeTradeOff(r, base);
      return r;
    },
    walkingDistance(from, to) {
      const s = index.nearestNode(from).node;
      const g = index.nearestNode(to).node;
      const steps = search(s.id, g.id, 'shortest');
      if (!steps) return null;
      return steps.reduce((sum, st) => sum + st.edge.length, 0) + index.nearestNode(from).meters + index.nearestNode(to).meters;
    },
  };
}

/** "Fewest crossings route: 2 minutes longer, 3 fewer crossings." Built from numbers only. */
export function describeTradeOff(r: Route, shortest: Route): string {
  const label = `${PROFILE_LABELS[r.profile]} route`;
  const parts: string[] = [];
  const dMin = Math.round((r.durationSeconds - shortest.durationSeconds) / 60);
  if (dMin > 0) parts.push(`${dMin} minute${dMin === 1 ? '' : 's'} longer`);
  else if (dMin < 0) parts.push(`${-dMin} minute${dMin === -1 ? '' : 's'} shorter`);
  else parts.push('about the same time');
  const dCross = shortest.crossings - r.crossings;
  if (dCross > 0) parts.push(`${dCross} fewer crossing${dCross === 1 ? '' : 's'}`);
  else if (dCross < 0) parts.push(`${-dCross} more crossing${dCross === -1 ? '' : 's'}`);
  const dSig = r.signalledCrossings - shortest.signalledCrossings;
  if (r.profile === 'fewestCrossings' && r.crossings > 0 && dSig !== 0 && dCross >= 0)
    parts.push(`${r.signalledCrossings} of ${r.crossings} with signals`);
  if (r.edgeIds.join() === shortest.edgeIds.join()) return `${label}: same as the shortest route.`;
  return `${label}: ${parts.join(', ')}.`;
}
