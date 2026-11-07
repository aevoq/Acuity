#!/usr/bin/env node
// Build an AreaPack (see src/contracts.ts) from OpenStreetMap, via the Overpass
// API. Run ONCE while online; the output JSON is committed and served from
// public/packs/, so the demo never depends on venue Wi-Fi (ADR-002).
//
//   node scripts/pack/build-pack.mjs                       # UCL East, 2 km
//   node scripts/pack/build-pack.mjs --lat 51.5375 --lng -0.0120 --radius 1500 --name "UCL East"
//   node scripts/pack/build-pack.mjs --from-cache          # rebuild from the last raw OSM download
//   node scripts/pack/build-pack.mjs --no-transit          # skip TfL bus stops and routes
//
// Steps:
//   1. One Overpass query: walkable ways (+ their nodes), crossings, named
//      places, benches, bus stops.
//   2. Walking graph: split ways at intersections, way ends and crossing nodes.
//      Each edge keeps its in-between points, length and tags.
//   3. Keep only the largest connected part of the graph, so a route never
//      starts on an island it cannot leave.
//   4. Places, benches and bus stops as flat lists.
//
// No dependencies: Node 20+ (global fetch).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');

// ---------------------------------------------------------------- arguments
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
// Marshgate, UCL East (geocoded from OSM).
const CENTER = { lat: Number(args.lat ?? 51.537542), lng: Number(args.lng ?? -0.0119821) };
const RADIUS = Number(args.radius ?? 2000);
const NAME = String(args.name ?? 'UCL East, Stratford');
const OUT = resolve(APP, String(args.out ?? 'public/packs/ucl-east.json'));
const RAW = resolve(HERE, '.cache/raw-overpass.json');
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

// ---------------------------------------------------------------- geometry
const R_EARTH = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const pt = (n) => ({ lat: round6(n.lat), lng: round6(n.lon ?? n.lng) });

// ---------------------------------------------------------------- 1. download
// Walkable highway values. Motorways and trunk link roads are excluded; big
// roads stay in because pavements are often mapped on the road itself.
const WALKABLE = 'footway|path|pedestrian|steps|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|cycleway|track|crossing|corridor|trunk';

function overpassQuery() {
  const a = `(around:${RADIUS},${CENTER.lat},${CENTER.lng})`;
  return `[out:json][timeout:120];
(
  way[highway~"^(${WALKABLE})$"]${a}[foot!~"^(no|private)$"][access!~"^(private|no)$"][area!=yes];
)->.ways;
.ways out body;
.ways >;
out body qt;
(
  nwr[shop][name]${a};
  nwr[amenity~"^(pharmacy|cafe|restaurant|fast_food|toilets|atm|bank|hospital|clinic|doctors|post_office|library|pub|bar)$"]${a};
  nwr[railway=station]${a};
  nwr[public_transport=station]${a};
  node[amenity=bench]${a};
  node[highway=bus_stop]${a};
);
out center tags;`;
}

async function download() {
  const body = 'data=' + encodeURIComponent(overpassQuery());
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      console.log(`Querying ${url} (radius ${RADIUS} m around ${CENTER.lat}, ${CENTER.lng}) ...`);
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'offline-nav-hackathon-pack-builder/0.1' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      await mkdir(dirname(RAW), { recursive: true });
      await writeFile(RAW, JSON.stringify(json));
      return json;
    } catch (e) {
      lastErr = e;
      console.warn(`  failed: ${e.message}`);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- 2. graph
function crossingFrom(tags) {
  const c = tags.crossing;
  let type = 'unknown';
  if (c === 'traffic_signals' || tags['crossing:signals'] === 'yes' || tags.crossing_ref === 'pelican' || tags.crossing_ref === 'puffin' || tags.crossing_ref === 'toucan') type = 'traffic_signals';
  else if (c === 'zebra' || tags.crossing_ref === 'zebra') type = 'zebra';
  else if (c === 'marked') type = 'marked';
  else if (c === 'uncontrolled' || c === 'unmarked' || c === 'informal') type = 'uncontrolled';
  const tp = tags.tactile_paving;
  const kerb = tags.kerb;
  return {
    type,
    tactilePaving: tp === 'yes' ? true : tp === 'no' ? false : null,
    kerb: kerb === 'lowered' || kerb === 'flush' || kerb === 'raised' ? kerb : null,
  };
}

function buildGraph(elements) {
  const osmNodes = new Map();
  const ways = [];
  for (const el of elements) {
    if (el.type === 'node' && el.lat != null) {
      // Keep the tagged copy if a node appears twice (body + skeleton).
      if (!osmNodes.has(el.id) || el.tags) osmNodes.set(el.id, el);
    } else if (el.type === 'way' && el.nodes && el.tags?.highway) {
      ways.push(el);
    }
  }

  // How many ways use each node; ends and shared nodes become graph nodes.
  const uses = new Map();
  for (const w of ways) for (const id of w.nodes) uses.set(id, (uses.get(id) ?? 0) + 1);
  const isGraphNode = (id, i, w) =>
    i === 0 || i === w.nodes.length - 1 || uses.get(id) > 1 || osmNodes.get(id)?.tags?.highway === 'crossing';

  const nodes = new Map();
  const edges = [];
  for (const w of ways) {
    const t = w.tags;
    const steps = t.highway === 'steps';
    const wayCrossing = t.footway === 'crossing' || t.highway === 'crossing' || t.path === 'crossing' || t.cycleway === 'crossing';
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (!isGraphNode(w.nodes[i], i, w)) continue;
      const seq = w.nodes.slice(start, i + 1).map((id) => osmNodes.get(id)).filter(Boolean);
      start = i;
      if (seq.length < 2) continue;
      let length = 0;
      for (let k = 1; k < seq.length; k++) length += haversine(pt(seq[k - 1]), pt(seq[k]));
      if (length < 0.5) continue;
      const [a, b] = [seq[0], seq[seq.length - 1]];
      for (const n of [a, b]) {
        if (nodes.has(String(n.id))) continue;
        const gn = { id: String(n.id), ...pt(n) };
        if (n.tags?.highway === 'crossing') gn.crossing = crossingFrom(n.tags);
        nodes.set(gn.id, gn);
      }
      const edge = {
        id: `${w.id}:${edges.length}`,
        from: String(a.id),
        to: String(b.id),
        length: Math.round(length * 10) / 10,
        geometry: seq.slice(1, -1).map(pt),
        name: t.name ?? null,
        roadClass: t.highway,
        steps,
        lit: t.lit === 'yes' ? true : t.lit === 'no' ? false : null,
        surface: t.surface ?? null,
      };
      if (wayCrossing) edge.crossing = crossingFrom(t);
      edges.push(edge);
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------- 3. largest component
function largestComponent(nodes, edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
  const seen = new Set();
  let best = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = new Set([start]);
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      for (const nb of adj.get(stack.pop())) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        comp.add(nb);
        stack.push(nb);
      }
    }
    if (comp.size > best.size) best = comp;
  }
  return {
    nodes: [...nodes.values()].filter((n) => best.has(n.id)),
    edges: edges.filter((e) => best.has(e.from) && best.has(e.to)),
    dropped: nodes.size - best.size,
  };
}

// ---------------------------------------------------------------- 4. places
function categoryOf(t) {
  if (t.highway === 'bus_stop') return ['bus_stop', 'highway=bus_stop'];
  if (t.amenity === 'bench') return ['bench', 'amenity=bench'];
  if (t.railway === 'station' || t.public_transport === 'station') return ['station', t.railway ? 'railway=station' : 'public_transport=station'];
  if (t.shop === 'supermarket' || t.shop === 'convenience') return ['supermarket', `shop=${t.shop}`];
  if (t.shop === 'chemist' || t.amenity === 'pharmacy') return ['pharmacy', t.amenity ? 'amenity=pharmacy' : 'shop=chemist'];
  if (t.shop) return ['shop', `shop=${t.shop}`];
  const a = t.amenity;
  if (a === 'cafe') return ['cafe', 'amenity=cafe'];
  if (a === 'restaurant' || a === 'fast_food' || a === 'pub' || a === 'bar') return ['restaurant', `amenity=${a}`];
  if (a === 'toilets') return ['toilets', 'amenity=toilets'];
  if (a === 'atm' || a === 'bank') return ['atm', `amenity=${a}`];
  if (a === 'hospital' || a === 'clinic' || a === 'doctors') return ['hospital', `amenity=${a}`];
  return ['other', a ? `amenity=${a}` : 'unknown'];
}

const FALLBACK_NAME = { toilets: 'Public toilets', atm: 'Cash machine', pharmacy: 'Pharmacy', cafe: 'Cafe' };

function extractPlaces(elements) {
  const places = [];
  const benches = [];
  const busStops = [];
  const seenPlace = new Set();
  for (const el of elements) {
    const t = el.tags;
    if (!t) continue;
    const loc = el.type === 'node' ? el : el.center;
    if (!loc || loc.lat == null) continue;
    const [category, osmTag] = categoryOf(t);
    if (category === 'bench') {
      benches.push(pt(loc));
      continue;
    }
    if (category === 'bus_stop') {
      busStops.push({ id: String(el.id), name: t.name ?? 'Bus stop', naptanId: t['naptan:AtcoCode'] ?? null, ...pt(loc) });
      continue;
    }
    // Walkable ways were only fetched for the graph; they have no shop/amenity tags.
    if (!t.shop && !t.amenity && !t.railway && !t.public_transport) continue;
    const name = t.name ?? t.brand ?? FALLBACK_NAME[category];
    if (!name) continue;
    const key = `${el.type}/${el.id}`;
    if (seenPlace.has(key)) continue;
    seenPlace.add(key);
    places.push({ id: key, name, brand: t.brand ?? null, category, osmTag, ...pt(loc) });
  }
  return { places, benches, busStops };
}

// ---------------------------------------------------------------- 5. transit (TfL)
// Bus stops in the area, every bus line serving them, and each line's ordered
// stops in both directions (Line/{id}/Route/Sequence). TfL's timetable
// endpoint returns nothing for buses, so "how often" is ESTIMATED from the gaps
// between live arrivals at one stop when the pack is built, and labelled so.
// Needs no API key at this volume (about 50 requests).
const TFL = 'https://api.tfl.gov.uk';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tfl(path) {
  // Anonymous TfL access allows roughly 50 requests a minute: pace at ~1.2/s
  // and back off for longer each time we are told to slow down.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(TFL + path, { headers: { 'user-agent': 'offline-nav-hackathon-pack-builder/0.1' } });
    if (res.status === 429) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`TfL ${path}: HTTP ${res.status}`);
    await sleep(800);
    return res.json();
  }
  throw new Error(`TfL ${path}: rate limited`);
}

const lineName = (id) => id.toUpperCase().replace(/^N(\d)/, 'N$1');

async function buildTransit() {
  const near = await tfl(`/StopPoint?lat=${CENTER.lat}&lon=${CENTER.lng}&stopTypes=NaptanPublicBusCoachTram&radius=${RADIUS}&modes=bus`);
  const areaStops = near.stopPoints ?? [];
  const lineIds = [...new Set(areaStops.flatMap((s) => (s.lines ?? []).map((l) => l.id)))].sort();
  console.log(`TfL: ${areaStops.length} bus stops in the area, ${lineIds.length} lines: ${lineIds.join(', ')}`);

  const stops = new Map(); // naptanId → BusStop
  // The same stop arrives from several queries; each fills in what the others lack
  // (the area query has lines, the route sequences have "towards" and the stop letter).
  const addStop = (s) => {
    const letter = s.stopLetter && !/^->/.test(s.stopLetter) ? `Stop ${s.stopLetter.trim()}` : null;
    // An arrow instead of a letter ("->N") means an unlettered stop for buses heading that way.
    const ARROWS = { N: 'northbound', S: 'southbound', E: 'eastbound', W: 'westbound', NE: 'north-eastbound', NW: 'north-westbound', SE: 'south-eastbound', SW: 'south-westbound' };
    const arrow = /^->\s*([NSEW]{1,2})$/.exec(s.stopLetter ?? s.indicator ?? '')?.[1];
    const fresh = {
      id: s.id,
      name: (s.name ?? s.commonName ?? 'Bus stop').replace(/\s+/g, ' ').trim(),
      naptanId: s.id,
      indicator: letter ?? (s.indicator && /^Stop /.test(s.indicator) ? s.indicator : null),
      towards: s.towards ? `towards ${s.towards}` : arrow ? ARROWS[arrow] : null,
      lines: (s.lines ?? []).map((l) => lineName(l.id ?? l.name)),
      ...pt({ lat: s.lat, lng: s.lon }),
    };
    const old = stops.get(s.id);
    if (!old) return stops.set(s.id, fresh);
    old.indicator ??= fresh.indicator;
    old.towards ??= fresh.towards;
    old.lines = [...new Set([...old.lines, ...fresh.lines])].sort();
  };
  for (const s of areaStops) addStop({ ...s, id: s.naptanId, name: s.commonName, towards: s.additionalProperties?.find((p) => p.key === 'Towards')?.value });

  const routes = [];
  for (const id of lineIds) {
    for (const direction of ['outbound', 'inbound']) {
      let seq;
      try {
        seq = await tfl(`/Line/${id}/Route/Sequence/${direction}`);
      } catch (e) {
        console.warn(`  ${id} ${direction}: ${e.message}`);
        continue;
      }
      if (seq.isOutboundOnly && direction === 'inbound') continue;
      const ordered = seq.orderedLineRoutes?.[0];
      const branch = seq.stopPointSequences?.[0];
      if (!branch?.stopPoint?.length) continue;
      for (const sp of branch.stopPoint) addStop({ ...sp, id: sp.id, name: sp.name, towards: sp.towards });
      const destination = branch.stopPoint[branch.stopPoint.length - 1].name.replace(/\s+/g, ' ').trim();
      routes.push({
        id: `${id}-${direction}`,
        name: lineName(id),
        direction,
        stops: branch.stopPoint.map((sp) => sp.id),
        frequencyMinutes: null,
        destination,
        _label: ordered?.name,
      });
    }
  }

  // Estimate frequency: at the first in-area stop of each route, the median
  // gap between that line's predicted arrivals.
  const inArea = new Set(areaStops.map((s) => s.naptanId));
  for (const r of routes) {
    const stopId = r.stops.find((s) => inArea.has(s));
    if (!stopId) continue;
    try {
      const arr = (await tfl(`/StopPoint/${stopId}/Arrivals`))
        .filter((a) => a.lineId === r.name.toLowerCase())
        .map((a) => a.timeToStation)
        .sort((a, b) => a - b);
      if (arr.length < 2) continue;
      const gaps = arr.slice(1).map((t, i) => (t - arr[i]) / 60).filter((g) => g > 0.5).sort((a, b) => a - b);
      if (!gaps.length) continue;
      const med = gaps[Math.floor(gaps.length / 2)];
      r.frequencyMinutes = { min: Math.max(1, Math.floor(med - 1)), max: Math.ceil(med + 2) };
      r.frequencySource = 'estimated-from-arrivals';
    } catch (e) {
      console.warn(`  arrivals for ${r.id}: ${e.message}`);
    }
  }
  for (const r of routes) delete r._label;
  console.log(`TfL: ${routes.length} route directions, ${stops.size} stops in their sequences, frequency estimated for ${routes.filter((r) => r.frequencyMinutes).length}`);
  return { busStops: [...stops.values()], busRoutes: routes };
}

// ---------------------------------------------------------------- main
async function main() {
  const raw = args['from-cache'] ? JSON.parse(await readFile(RAW, 'utf8')) : await download();
  const elements = raw.elements ?? [];
  console.log(`Got ${elements.length} OSM elements.`);

  const g = buildGraph(elements);
  const { nodes, edges, dropped } = largestComponent(g.nodes, g.edges);
  const { places, benches, busStops: osmStops } = extractPlaces(elements);

  // Bus stops and routes from TfL; OSM's stops are the fallback if TfL fails.
  let busStops = osmStops;
  let busRoutes = [];
  if (!args['no-transit']) {
    try {
      const transit = await buildTransit();
      busStops = transit.busStops;
      busRoutes = transit.busRoutes;
    } catch (e) {
      console.warn(`TfL transit failed (${e.message}); keeping ${osmStops.length} OSM bus stops and no routes.`);
    }
  }

  // Bounding box of the circle, for the map view.
  const dLat = (RADIUS / R_EARTH) * (180 / Math.PI);
  const dLng = dLat / Math.cos(toRad(CENTER.lat));
  const pack = {
    version: 1,
    createdAt: new Date().toISOString(),
    name: NAME,
    center: CENTER,
    radiusMeters: RADIUS,
    bounds: { south: round6(CENTER.lat - dLat), west: round6(CENTER.lng - dLng), north: round6(CENTER.lat + dLat), east: round6(CENTER.lng + dLng) },
    nodes,
    edges,
    places,
    benches,
    busStops,
    busRoutes,
    attribution: busRoutes.length
      ? '© OpenStreetMap contributors (ODbL); bus data powered by TfL Open Data'
      : '© OpenStreetMap contributors (ODbL)',
  };

  await mkdir(dirname(OUT), { recursive: true });
  const json = JSON.stringify(pack);
  await writeFile(OUT, json);

  const crossings = nodes.filter((n) => n.crossing).length + edges.filter((e) => e.crossing).length;
  const signalled = nodes.filter((n) => n.crossing?.type === 'traffic_signals').length + edges.filter((e) => e.crossing?.type === 'traffic_signals').length;
  const km = edges.reduce((s, e) => s + e.length, 0) / 1000;
  console.log(`Wrote ${OUT} (${(json.length / 1e6).toFixed(2)} MB)`);
  console.log(`  graph: ${nodes.length} nodes, ${edges.length} edges, ${km.toFixed(1)} km walkable (dropped ${dropped} nodes in small islands)`);
  console.log(`  crossings: ${crossings} (${signalled} with signals), steps edges: ${edges.filter((e) => e.steps).length}`);
  console.log(`  places: ${places.length}, benches: ${benches.length}, bus stops: ${busStops.length}`);
  const tesco = places.filter((p) => /tesco/i.test(`${p.name} ${p.brand ?? ''}`));
  console.log(`  Tesco check (F1 acceptance): ${tesco.length ? tesco.map((p) => p.name).join(', ') : 'NONE FOUND, pick another demo brand'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
