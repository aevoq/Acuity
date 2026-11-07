// Smoke test for the offline core, run against the real pack in Node:
//   npx tsx scripts/check/nav-check.ts
// Routes from the venue to the nearest Tesco under every profile, prints the
// trade-offs and waypoints, then replays a walk through the guidance engine.
import { readFileSync } from 'node:fs';
import type { AreaPack, Position, PositionSource, RouteProfileId, SpeakRequest } from '../../src/contracts';
import { pointAlong, destination } from '../../src/geo/geo';
import { indexPack } from '../../src/pack/pack';
import { createRouter } from '../../src/nav/router';
import { createGuidance } from '../../src/nav/guidance';
import { findPlaces } from '../../src/places/search';

const VENUE = { lat: 51.537542, lng: -0.0119821 };
let t = performance.now();
const index = indexPack(JSON.parse(readFileSync(new URL('../../public/packs/ucl-east.json', import.meta.url), 'utf8')) as AreaPack);
const router = createRouter(index);
console.log(`index + router ready in ${(performance.now() - t).toFixed(0)} ms`);

for (const q of ['Where is the nearest Tesco?', 'pharmacy', 'toilets', 'coffee', 'Stratford station']) {
  t = performance.now();
  const hits = findPlaces(index, router, VENUE, q, 3);
  console.log(`"${q}" → ${hits.map((h) => `${h.place.name} (walk ${h.walkMeters?.toFixed(0)} m, straight ${h.straightMeters.toFixed(0)} m)`).join('; ') || 'none'} [${(performance.now() - t).toFixed(0)} ms]`);
}

const dest = findPlaces(index, router, VENUE, 'tesco', 1)[0].place;
const profiles: RouteProfileId[] = ['shortest', 'fewestCrossings', 'mainRoads', 'stepFree', 'restStops'];
for (const p of profiles) {
  t = performance.now();
  const r = router.route(VENUE, dest, p, dest.name)!;
  console.log(`\n[${p}] ${r.lengthMeters} m, ${Math.round(r.durationSeconds / 60)} min, ${r.crossings} crossings (${r.signalledCrossings} signalled), ${r.waypoints.length} waypoints [${(performance.now() - t).toFixed(0)} ms]`);
  if (r.tradeOff) console.log(`  trade-off: ${r.tradeOff}`);
  if (p === 'shortest' || p === 'fewestCrossings') for (const w of r.waypoints) console.log(`  ${String(w.distanceAlong).padStart(5)} m  ${w.kind.padEnd(8)} ${w.instruction}`);
}

// Replay a walk through the guidance engine with a manual source: 1.4 m steps,
// a 40 m sideways detour around 200-215 m, and poor GPS around 300-310 m.
const route = router.route(VENUE, dest, 'shortest', dest.name)!;
const listeners = new Set<(p: Position) => void>();
const source: PositionSource = { kind: 'simulated', start() {}, stop() {}, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)), current: () => null };
const spoken: string[] = [];
const g = createGuidance({ route, source, onSpeak: (r: SpeakRequest) => spoken.push(`${r.milestone ? `[${r.milestone}] ` : ''}${r.text}`), reassuranceEveryMeters: 100 });
g.start();
for (let m = 0; m <= route.lengthMeters + 5; m += 1.4) {
  const { point, bearing } = pointAlong(route.path, m);
  const off = m > 200 && m < 215 ? 40 : 0;
  const p = off ? destination(point, bearing + 90, off) : point;
  const pos: Position = { ...p, accuracy: m > 300 && m < 310 ? 45 : 5, heading: bearing, speed: 1.4, timestamp: Date.now(), source: 'simulated' };
  for (const l of listeners) l(pos);
  if (m > 120 && m < 121.5) console.log(`\n(at ${m.toFixed(0)} m) next step: ${g.nextStep()}`);
}
console.log('\nSpoken during the walk:');
for (const s of spoken) console.log('  ' + s);
console.log('final state:', JSON.stringify({ ...g.state(), next: undefined, lastPosition: undefined }));
