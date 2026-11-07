#!/usr/bin/env node
// Download a full-detail offline copy of the OpenFreeMap "Liberty" map for an
// area around the venue: vector tiles (roads, buildings, parks, water, names,
// landmarks), the label fonts and the icon sprites. Saved under public/map/ so
// the service worker caches them and the map looks the same with Wi-Fi off.
//
//   node scripts/map/fetch-offline-map.mjs                 # 10 km box around UCL East
//   node scripts/map/fetch-offline-map.mjs --km 14
//
// The app loads ONE style (public/map/style.json) whose URLs use the ofm://
// protocol (src/mapview/ofmProtocol.ts): a tile/font/sprite is read from this
// download when we have it, and from tiles.openfreemap.org otherwise (online,
// anywhere in the world). Map data © OpenMapTiles © OpenStreetMap contributors.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../public/map');
const ORIGIN = 'https://tiles.openfreemap.org';
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const CENTER = { lat: Number(args.lat ?? 51.537542), lng: Number(args.lng ?? -0.0119821) };
const KM = Number(args.km ?? 10);
const MAX_Z = 14; // OpenFreeMap's vector tiles stop at 14; the map overzooms beyond
const GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023', '8192-8447', '8448-8703'];

const half = (KM * 1000) / 2;
const dLat = half / 111195;
const dLng = half / (111195 * Math.cos((CENTER.lat * Math.PI) / 180));
const BBOX = { west: CENTER.lng - dLng, south: CENTER.lat - dLat, east: CENTER.lng + dLng, north: CENTER.lat + dLat };

const tileX = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
function tilesFor(z) {
  const out = [];
  for (let x = tileX(BBOX.west, z); x <= tileX(BBOX.east, z); x++)
    for (let y = tileY(BBOX.north, z); y <= tileY(BBOX.south, z); y++) out.push([z, x, y]);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'offline-nav-hackathon-map-fetch/0.1' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${e.message}`);
      await sleep(1000 * (attempt + 1));
    }
  }
}

/** Run `fn` over `items` with a few requests in flight. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function save(path, buf) {
  const file = resolve(OUT, 'ofm', path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
}

async function main() {
  const style = JSON.parse((await get(`${ORIGIN}/styles/liberty`)).toString());
  const tilejson = JSON.parse((await get(`${ORIGIN}/planet`)).toString());
  const tileTemplate = tilejson.tiles[0]; // .../planet/<version>/{z}/{x}/{y}.pbf
  console.log(`Liberty style, ${style.layers.length} layers; tiles ${tileTemplate}`);
  await rm(OUT, { recursive: true, force: true });

  const files = [];
  let bytes = 0;
  const keep = async (path, buf) => {
    if (!buf) return;
    await save(path, buf);
    files.push(path);
    bytes += buf.length;
  };

  // 1. Vector tiles, every zoom 0-14 over the box.
  const tiles = [];
  for (let z = 0; z <= MAX_Z; z++) tiles.push(...tilesFor(z));
  console.log(`Downloading ${tiles.length} vector tiles for a ${KM} km box…`);
  await pool(tiles, 8, async ([z, x, y]) => keep(`planet/${z}/${x}/${y}`, await get(tileTemplate.replace('{z}', z).replace('{x}', x).replace('{y}', y))));

  // 2. Shaded relief raster used at world zooms (0-6), over the box.
  const raster = style.sources.ne2_shaded;
  const rasterTiles = [];
  for (let z = 0; z <= (raster?.maxzoom ?? 6); z++) rasterTiles.push(...tilesFor(z));
  await pool(rasterTiles, 4, async ([z, x, y]) => keep(`natural_earth/ne2sr/${z}/${x}/${y}.png`, await get(`${ORIGIN}/natural_earth/ne2sr/${z}/${x}/${y}.png`)));

  // 3. Fonts: every font stack the style uses, Latin + punctuation ranges.
  const stacks = new Set();
  for (const l of style.layers) {
    const tf = l.layout?.['text-font'];
    if (Array.isArray(tf) && tf.every((f) => typeof f === 'string')) stacks.add(tf.join(','));
  }
  for (const stack of stacks)
    for (const range of GLYPH_RANGES) await keep(`fonts/${stack}/${range}.pbf`, await get(`${ORIGIN}/fonts/${encodeURIComponent(stack)}/${range}.pbf`));

  // 4. Icon sprites (1x and 2x).
  const spritePath = style.sprite.replace(`${ORIGIN}/`, ''); // sprites/ofm_f384/ofm
  for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) await keep(`${spritePath}${suffix}`, await get(`${style.sprite}${suffix}`));

  // 5. The style, pointed at the ofm:// protocol (local first, then online).
  style.sources.openmaptiles = { type: 'vector', tiles: ['ofm://planet/{z}/{x}/{y}'], minzoom: 0, maxzoom: MAX_Z, attribution: tilejson.attribution ?? style.sources.openmaptiles.attribution };
  if (raster) raster.tiles = ['ofm://natural_earth/ne2sr/{z}/{x}/{y}.png'];
  style.glyphs = 'ofm://fonts/{fontstack}/{range}.pbf';
  style.sprite = `ofm://${spritePath}`;
  await writeFile(resolve(OUT, 'style.json'), JSON.stringify(style));

  // 6. What we have offline, so the protocol never asks the dev server for a missing file.
  const manifest = { createdAt: new Date().toISOString(), km: KM, center: CENTER, bbox: BBOX, tileTemplate, files };
  await writeFile(resolve(OUT, 'manifest.json'), JSON.stringify(manifest));
  console.log(`Saved ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
