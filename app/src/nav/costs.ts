// Route preference profiles as edge costs (F3, ADR-003).
//
// The router always finds the lowest-cost path. "Shortest" means cost =
// length. Every other profile is a different cost: multipliers and penalties
// on the edges the person wants to avoid. Changing the profile changes the
// weights, not the algorithm.
//
// The values are starting guesses from the PRD. Tune them with participants
// and record the final values in the PRD's ADR log.
//
// Every multiplier is >= 1, so straight-line distance stays a valid A*
// heuristic (it never overestimates the remaining cost).

import type { GraphEdge, GraphNode, RouteProfileId } from '../contracts';

/** Highway values that are alleys, service roads or unpaved paths. */
const BACK_WAYS = new Set(['service', 'track', 'path']);
/** Highway values that are roads with traffic, i.e. "main roads" with pavements. */
const MAIN_ROADS = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'trunk']);
/** Ways made for walking, as opposed to roads with pavements mapped on them. */
const FOOT_WAYS = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'corridor', 'crossing']);

export const PROFILE_LABELS: Record<RouteProfileId, string> = {
  shortest: 'Shortest',
  fewestCrossings: 'Fewest crossings',
  mainRoads: 'Main roads',
  stepFree: 'Step-free',
  restStops: 'Rest stops',
};

export interface CostContext {
  /** Edge ids with a bench within about 25 m (rest-stops profile). */
  nearBench: Set<string>;
}

/**
 * Whether walking this edge into `to` means crossing a road there.
 *
 * OSM maps a crossing two ways: as a crossing node where a footway meets a
 * road, and/or as a short footway=crossing way. A crossing node only counts
 * when we arrive on a footway or crossing way (walking along the road through
 * a crossing node is not crossing). A crossing way with no crossing node at
 * either end counts on its own. This counts each real crossing once.
 */
export function crossingAt(edge: GraphEdge, from: GraphNode, to: GraphNode): GraphNode['crossing'] | null {
  if (to.crossing && (edge.crossing || FOOT_WAYS.has(edge.roadClass))) return to.crossing;
  if (edge.crossing && !from.crossing && !to.crossing) return edge.crossing;
  return null;
}

/** Cost of walking `edge` from `from` to `to` under a profile, or Infinity if not allowed. */
export function edgeCost(profile: RouteProfileId, edge: GraphEdge, from: GraphNode, to: GraphNode, ctx: CostContext): number {
  const len = edge.length;
  const crossing = crossingAt(edge, from, to);

  switch (profile) {
    case 'shortest':
      return len;

    case 'fewestCrossings': {
      if (!crossing) return len;
      return len + (crossing.type === 'traffic_signals' ? 150 : 400);
    }

    case 'mainRoads': {
      let m = 1;
      if (BACK_WAYS.has(edge.roadClass)) m *= 3; // alleys, service roads, unpaved paths
      if (edge.lit === false) m *= 1.5; // known unlit
      else if (edge.lit == null && !MAIN_ROADS.has(edge.roadClass)) m *= 1.2; // unknown, off the main roads
      return len * m + (crossing && crossing.type !== 'traffic_signals' ? 100 : 0);
    }

    case 'stepFree': {
      if (edge.steps) return Infinity;
      // A crossing with a known raised kerb is a step too.
      if (crossing?.kerb === 'raised') return len + 300;
      return len;
    }

    case 'restStops':
      // Edges with a bench nearby cost their length; edges without cost 30% more,
      // so the route bends towards benches when the detour is small.
      return ctx.nearBench.has(edge.id) ? len : len * 1.3;
  }
}
