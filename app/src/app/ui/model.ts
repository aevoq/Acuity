// Shapes and wording shared by the cards. A "target" is anything you can walk
// to: a place from the pack, or a bus stop.

import type { BusStop, LatLng, Place, PlaceCategory } from '../../contracts';
import { bearing } from '../../geo/geo';
import { compassWord } from '../../nav/instructions';
import { WALKING_SPEED } from '../../nav/router';

export interface Target extends LatLng {
  id: string;
  name: string;
  category: PlaceCategory;
  place?: Place;
  stop?: BusStop;
}

export const placeTarget = (p: Place): Target => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, category: p.category, place: p });
export const stopTarget = (s: BusStop): Target => ({ id: `stop:${s.id}`, name: s.name, lat: s.lat, lng: s.lng, category: 'bus_stop', stop: s });

/** "Ucl East & Bobby Moore Academy Secondary, Stop N" */
export const targetName = (t: Target) => (t.stop?.indicator ? `${t.name}, ${t.stop.indicator}` : t.name);

export interface ResultItem {
  target: Target;
  /** Walking distance, or straight-line × 1.3 when unreachable. */
  walk: number;
  /** Outside the downloaded area: straight-line distance, reach it by transport or taxi. */
  far?: boolean;
}

export interface Answer {
  q: string;
  icon: string;
  text: string;
  items: Array<{ target: Target; meters: number }>;
  goTo?: Target;
}

const LABEL: Record<string, string> = {
  shop: 'Shop', supermarket: 'Supermarket', pharmacy: 'Pharmacy', cafe: 'Café', restaurant: 'Restaurant', toilets: 'Toilets',
  station: 'Station', bus_stop: 'Bus stop', atm: 'Cash machine', hospital: 'Hospital', bench: 'Bench', park: 'Park',
};
const ICON: Record<string, string> = {
  cafe: 'local_cafe', restaurant: 'restaurant', shop: 'storefront', supermarket: 'shopping_cart', pharmacy: 'local_pharmacy',
  hospital: 'local_hospital', toilets: 'wc', atm: 'local_atm', station: 'train', bus_stop: 'directions_bus', bench: 'chair', park: 'park',
};
export const catLabel = (c: string) => LABEL[c] ?? 'Place';
export const catIcon = (c: string) => ICON[c] ?? 'place';

/** "130 m", "1.4 km" */
export function fmtDist(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${m < 15 ? Math.max(5, Math.round(m / 5) * 5) : Math.round(m / 10) * 10} m`;
}

/** Walking minutes at the router's pace. */
export const walkMinutes = (m: number) => Math.max(1, Math.round(m / WALKING_SPEED / 60));

/** "north-east" from one point to another. */
export const directionFrom = (from: LatLng, to: LatLng) => compassWord(bearing(from, to));
