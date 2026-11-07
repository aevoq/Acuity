// Searching beyond the downloaded area (online): Photon, a free OpenStreetMap
// geocoder (komoot), limited to Greater London and biased to where you are.
// Used only when nothing in the pack matches, so offline search still works
// exactly as before. Walking directions need the pack; a place found here can
// be reached by public transport (TfL) or taxi.

import type { LatLng, Place, PlaceCategory } from '../contracts';
import { onlineFetch } from '../net/online';

/** Greater London, west/south/east/north. */
const LONDON = '-0.52,51.28,0.34,51.70';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    osm_type?: string;
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    city?: string;
  };
}

function categoryOf(key = '', value = ''): PlaceCategory {
  if (value === 'supermarket' || value === 'convenience') return 'supermarket';
  if (value === 'pharmacy' || value === 'chemist') return 'pharmacy';
  if (value === 'cafe') return 'cafe';
  if (['restaurant', 'fast_food', 'pub', 'bar'].includes(value)) return 'restaurant';
  if (value === 'toilets') return 'toilets';
  if (value === 'atm' || value === 'bank') return 'atm';
  if (['hospital', 'clinic', 'doctors'].includes(value)) return 'hospital';
  if (value === 'station' || key === 'railway' || value === 'subway_entrance') return 'station';
  if (value === 'bus_stop') return 'bus_stop';
  if (key === 'shop') return 'shop';
  return 'other';
}

/** Places anywhere in London matching `query`, nearest first. Never throws. */
export async function geocodeLondon(query: string, near: LatLng, limit = 6): Promise<{ ok: true; places: Place[] } | { ok: false; offline: boolean }> {
  const q = new URLSearchParams({ q: query, lat: near.lat.toFixed(5), lon: near.lng.toFixed(5), limit: String(limit), lang: 'en', bbox: LONDON });
  const r = await onlineFetch<{ features?: PhotonFeature[] }>(`https://photon.komoot.io/api/?${q}`, { timeoutMs: 6000 });
  if (!r.ok) return { ok: false, offline: r.reason === 'offline' };
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const f of r.data.features ?? []) {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const name = p.name ?? [p.housenumber, p.street].filter(Boolean).join(' ');
    if (!name) continue;
    const key = `${name}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({
      id: `geo:${p.osm_type ?? ''}${p.osm_id ?? key}`,
      name,
      brand: null,
      category: categoryOf(p.osm_key, p.osm_value),
      osmTag: `${p.osm_key ?? ''}=${p.osm_value ?? ''}`,
      lat,
      lng,
    });
  }
  return { ok: true, places };
}

/** "Gower Street, Fitzrovia" style line for a result, when Photon gives one. */
export const areaOf = (p: Place) => p.osmTag;
