// The ofm:// protocol: where the base map's tiles, fonts and icons come from.
//
// public/map/style.json (made by scripts/map/fetch-offline-map.mjs) points
// every URL at ofm://… . For each request:
//   1. we downloaded it (the 10 km box around the venue) → read it from
//      /map/ofm/… (cached by the service worker, so it works offline);
//   2. else, online → fetch it from tiles.openfreemap.org (anywhere in the world);
//   3. else, offline → an empty tile, so the map shows blank land, not errors.
// Online and offline use the same style, so the map looks identical.

import { addProtocol, setWorkerUrl } from 'maplibre-gl';
// MapLibre parses tiles in a web worker. Vite moves the library when it
// bundles it, so tell MapLibre where its (self-contained) worker file is.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { connectivity } from '../net/connectivity';

const BASE = `${import.meta.env?.BASE_URL ?? '/'}map/`;
const ORIGIN = 'https://tiles.openfreemap.org';

interface Manifest {
  files: Set<string>;
  tileTemplate: string;
}

let manifest: Promise<Manifest> | null = null;
function loadManifest(): Promise<Manifest> {
  manifest ??= fetch(`${BASE}manifest.json`)
    .then((r) => r.json())
    .then((m: { files: string[]; tileTemplate: string }) => ({ files: new Set(m.files), tileTemplate: m.tileTemplate }))
    .catch(() => ({ files: new Set<string>(), tileTemplate: `${ORIGIN}/planet/{z}/{x}/{y}.pbf` }));
  return manifest;
}

/** The current OpenFreeMap tile URL (it carries a data version), asked once per session. */
let liveTemplate: Promise<string> | null = null;
function tileTemplate(fallback: string): Promise<string> {
  liveTemplate ??= fetch(`${ORIGIN}/planet`)
    .then((r) => r.json())
    .then((tj: { tiles?: string[] }) => tj.tiles?.[0] ?? fallback)
    .catch(() => {
      liveTemplate = null; // try again next time
      return fallback;
    });
  return liveTemplate;
}

const localUrl = (path: string) => `${BASE}ofm/${path.split('/').map(encodeURIComponent).join('/')}`;
const EMPTY = () => ({ data: new ArrayBuffer(0) });

async function read(res: Response, type: string | undefined) {
  if (type === 'json') return { data: await res.json() };
  if (type === 'string') return { data: await res.text() };
  return { data: await res.arrayBuffer() };
}

let registered = false;
export function registerOfmProtocol() {
  if (registered) return;
  registered = true;
  setWorkerUrl(workerUrl);
  addProtocol('ofm', async (params, abort) => {
    const path = decodeURIComponent(params.url.replace(/^ofm:\/\//, ''));
    const isTile = path.startsWith('planet/');
    const m = await loadManifest();

    if (m.files.has(path)) {
      const res = await fetch(localUrl(path), { signal: abort.signal });
      if (res.ok) return read(res, params.type);
    }
    if (connectivity.mode() === 'offline') {
      if (isTile) return EMPTY();
      throw new Error(`Offline, and ${path} was not downloaded`);
    }

    let url: string;
    if (isTile) {
      const [, z, x, y] = path.split('/');
      url = (await tileTemplate(m.tileTemplate)).replace('{z}', z).replace('{x}', x).replace('{y}', y);
    } else if (path.startsWith('fonts/')) {
      const [, stack, file] = path.split('/');
      url = `${ORIGIN}/fonts/${encodeURIComponent(stack)}/${file}`;
    } else {
      url = `${ORIGIN}/${path}`;
    }
    const res = await fetch(url, { signal: abort.signal });
    if (res.status === 404 && isTile) return EMPTY(); // ocean, edge of the world
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return read(res, params.type);
  });
}

export const STYLE_URL = `${BASE}style.json`;
