#!/usr/bin/env node
// Add parks, gardens and playgrounds to the existing area pack, so "where is
// the nearest park?" can be answered offline. A top-up: it does not redo the
// walking graph or the TfL bus data (npm run pack does everything).
//
//   node scripts/pack/add-parks.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/packs/ucl-east.json');
const pack = JSON.parse(await readFile(PACK, 'utf8'));
const { lat, lng } = pack.center;
const q = `[out:json][timeout:90];
(
  nwr[leisure~"^(park|garden|playground|nature_reserve|common)$"][name](around:${pack.radiusMeters},${lat},${lng});
);
out center tags;`;
// Overpass servers are often busy: try the main one and a mirror, a few times.
async function overpass() {
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = endpoints[attempt % endpoints.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'offline-nav-hackathon-pack-builder/0.1' },
      });
      if (res.ok) return (await res.json()).elements ?? [];
      console.warn(`  ${url}: HTTP ${res.status}, retrying…`);
    } catch (e) {
      console.warn(`  ${url}: ${e.message}, retrying…`);
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error('Overpass unavailable; try again later');
}
const els = await overpass();
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const before = pack.places.length;
pack.places = pack.places.filter((p) => p.category !== 'park'); // re-runnable
const seen = new Set();
for (const el of els) {
  const loc = el.type === 'node' ? el : el.center;
  const name = el.tags?.name;
  if (!loc || !name) continue;
  const key = `${name}|${Math.round(loc.lat * 1000)}|${Math.round(loc.lon * 1000)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  pack.places.push({ id: `${el.type}/${el.id}`, name, brand: null, category: 'park', osmTag: `leisure=${el.tags.leisure}`, lat: r6(loc.lat), lng: r6(loc.lon) });
}
await writeFile(PACK, JSON.stringify(pack));
console.log(`Parks, gardens and playgrounds: ${seen.size} named. Places ${before} → ${pack.places.length}.`);
