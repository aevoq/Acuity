// Loading the area pack and indexing it for fast offline lookups.
//
// The pack is a static file (public/packs/*.json) built once by
// scripts/pack/build-pack.mjs. The service worker caches it on first load, so
// after that it loads with no network at all.
//
//   const pack = await loadPack();            // AreaPack + indexes
//   pack.node('123'); pack.edgesAt('123');    // graph lookups for the router
//   pack.nearestNode(position);               // snap a GPS reading to the graph
//   pack.placesNear(position, 50);            // "what's around me"

import type { AreaPack, BusStop, GraphEdge, GraphNode, LatLng, Place } from '../contracts';
import { distance, distanceToPolyline, makeProjection } from '../geo/geo';

// `import.meta.env` only exists under Vite; the fallback lets Node scripts import this file.
export const DEFAULT_PACK_URL = `${import.meta.env?.BASE_URL ?? '/'}packs/ucl-east.json`;

export interface PackIndex {
  pack: AreaPack;
  node(id: string): GraphNode | undefined;
  edge(id: string): GraphEdge | undefined;
  /** Edges touching a node (the graph is undirected). */
  edgesAt(nodeId: string): GraphEdge[];
  /** The other end of an edge, seen from `nodeId`. */
  otherEnd(edge: GraphEdge, nodeId: string): string;
  /** Edge geometry from `fromId` to the other end, including both end points. */
  edgeLine(edge: GraphEdge, fromId: string): LatLng[];
  /** Nearest graph node to a point, and how far it is. */
  nearestNode(p: LatLng): { node: GraphNode; meters: number };
  /** Places within `meters`, nearest first (straight-line distance). */
  placesNear(p: LatLng, meters: number, limit?: number): Array<{ place: Place; meters: number }>;
  /** Graph nodes within `meters`, nearest first. */
  nodesNear(p: LatLng, meters: number): Array<{ node: GraphNode; meters: number }>;
  /** The nearest edge with a street name within `meters`, for "where am I". */
  streetAt(p: LatLng, meters?: number): { name: string; meters: number; edge: GraphEdge } | null;
  /** Bus stops within `meters`, nearest first. */
  busStopsNear(p: LatLng, meters: number, limit?: number): Array<{ stop: BusStop; meters: number }>;
  /** Age of the data in whole days, for "this map is 3 days old". */
  ageDays(now?: number): number;
}

/** A coarse grid over the area so "nearest" questions don't scan 17,000 nodes. */
function makeGrid<T extends LatLng>(items: T[], origin: LatLng, cellMeters: number) {
  const proj = makeProjection(origin);
  const cells = new Map<string, T[]>();
  const keyOf = (p: LatLng) => {
    const { x, y } = proj.toXY(p);
    return [Math.floor(x / cellMeters), Math.floor(y / cellMeters)] as const;
  };
  for (const it of items) {
    const [cx, cy] = keyOf(it);
    const k = `${cx},${cy}`;
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(it);
  }
  /** Items in the cells within `ring` cells of p. */
  const around = (p: LatLng, ring: number): T[] => {
    const [cx, cy] = keyOf(p);
    const out: T[] = [];
    for (let dx = -ring; dx <= ring; dx++)
      for (let dy = -ring; dy <= ring; dy++) {
        const list = cells.get(`${cx + dx},${cy + dy}`);
        if (list) out.push(...list);
      }
    return out;
  };
  return { around };
}

export function indexPack(pack: AreaPack): PackIndex {
  const nodes = new Map(pack.nodes.map((n) => [n.id, n]));
  const edges = new Map(pack.edges.map((e) => [e.id, e]));
  const adj = new Map<string, GraphEdge[]>();
  for (const e of pack.edges) {
    for (const id of [e.from, e.to]) {
      let list = adj.get(id);
      if (!list) adj.set(id, (list = []));
      list.push(e);
    }
  }
  const CELL = 100;
  const nodeGrid = makeGrid(pack.nodes, pack.center, CELL);
  const placeGrid = makeGrid(pack.places, pack.center, CELL);
  const stopGrid = makeGrid(pack.busStops, pack.center, CELL);

  const api: PackIndex = {
    pack,
    node: (id) => nodes.get(id),
    edge: (id) => edges.get(id),
    edgesAt: (id) => adj.get(id) ?? [],
    otherEnd: (e, id) => (e.from === id ? e.to : e.from),
    edgeLine(e, fromId) {
      const a = nodes.get(e.from)!;
      const b = nodes.get(e.to)!;
      const line = [a, ...e.geometry, b].map((p) => ({ lat: p.lat, lng: p.lng }));
      return e.from === fromId ? line : line.reverse();
    },
    nearestNode(p) {
      // Widen the search ring until something is found (the edge of the pack is sparse).
      for (let ring = 1; ring <= 40; ring *= 2) {
        let best: GraphNode | null = null;
        let bestD = Infinity;
        for (const n of nodeGrid.around(p, ring)) {
          const d = distance(p, n);
          if (d < bestD) [best, bestD] = [n, d];
        }
        if (best && bestD <= ring * CELL) return { node: best, meters: bestD };
      }
      let best = pack.nodes[0];
      for (const n of pack.nodes) if (distance(p, n) < distance(p, best)) best = n;
      return { node: best, meters: distance(p, best) };
    },
    placesNear(p, meters, limit = Infinity) {
      const ring = Math.ceil(meters / CELL);
      return placeGrid
        .around(p, ring)
        .map((place) => ({ place, meters: distance(p, place) }))
        .filter((r) => r.meters <= meters)
        .sort((a, b) => a.meters - b.meters)
        .slice(0, limit);
    },
    nodesNear(p, meters) {
      return nodeGrid
        .around(p, Math.ceil(meters / CELL))
        .map((node) => ({ node, meters: distance(p, node) }))
        .filter((r) => r.meters <= meters)
        .sort((a, b) => a.meters - b.meters);
    },
    streetAt(p, meters = 60) {
      let best: { name: string; meters: number; edge: GraphEdge } | null = null;
      const seen = new Set<string>();
      for (const { node } of api.nodesNear(p, meters * 2)) {
        for (const e of adj.get(node.id) ?? []) {
          if (!e.name || seen.has(e.id)) continue;
          seen.add(e.id);
          const d = distanceToPolyline(p, api.edgeLine(e, e.from));
          if (d <= meters && (!best || d < best.meters)) best = { name: e.name, meters: d, edge: e };
        }
      }
      return best;
    },
    busStopsNear(p, meters, limit = Infinity) {
      return stopGrid
        .around(p, Math.ceil(meters / CELL))
        .map((stop) => ({ stop, meters: distance(p, stop) }))
        .filter((r) => r.meters <= meters)
        .sort((a, b) => a.meters - b.meters)
        .slice(0, limit);
    },
    ageDays(now = Date.now()) {
      return Math.max(0, Math.floor((now - Date.parse(pack.createdAt)) / 86_400_000));
    },
  };
  return api;
}

let cached: Promise<PackIndex> | null = null;

/** Load (once) and index the area pack. Works offline once the service worker has cached it. */
export function loadPack(url = DEFAULT_PACK_URL): Promise<PackIndex> {
  if (!cached) {
    cached = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Area pack not found (${r.status}). Run: node scripts/pack/build-pack.mjs`);
        return r.json() as Promise<AreaPack>;
      })
      .then(indexPack)
      .catch((e) => {
        cached = null; // allow a retry
        throw e;
      });
  }
  return cached;
}
