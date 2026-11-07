// Finding places in the area pack by name, brand or kind, ranked by walking
// distance (F4 "nearest X", and picking a destination for F2). Offline.
//
//   const hits = findPlaces(index, router, here, 'tesco');
//   hits[0] // { place, walkMeters, straightMeters }

import type { LatLng, Place, PlaceCategory } from '../contracts';
import { distance } from '../geo/geo';
import type { PackIndex } from '../pack/pack';
import type { Router } from '../nav/router';

/** Everyday words for a kind of place → pack categories / OSM tags. */
const KIND_WORDS: Array<{ re: RegExp; categories?: PlaceCategory[]; tag?: RegExp }> = [
  { re: /\b(supermarket|grocer(y|ies)|food shop|convenience)\b/, categories: ['supermarket'] },
  { re: /\b(pharmacy|chemist|drug ?store)\b/, categories: ['pharmacy'] },
  { re: /\b(toilets?|loo|bathroom|restroom|wc)\b/, categories: ['toilets'] },
  { re: /\b(cafe|café|coffee)\b/, categories: ['cafe'] },
  { re: /\b(restaurant|food|eat|lunch|dinner|pub|bar)\b/, categories: ['restaurant', 'cafe'] },
  { re: /\b(cash ?machine|cashpoint|atm|bank)\b/, categories: ['atm'] },
  { re: /\b(station|train|tube|overground|dlr)\b/, categories: ['station'] },
  { re: /\b(hospital|doctor|gp|clinic|surgery)\b/, categories: ['hospital'] },
  { re: /\b(post office)\b/, tag: /post_office/ },
  { re: /\b(library)\b/, tag: /library/ },
];

const STOP_WORDS = /\b(the|a|an|nearest|closest|near|nearby|where('?s| is)?|is|find|me|take|to|go|get|navigate|directions|how do i|i want|please|any)\b/g;

export function normaliseQuery(q: string): string {
  return q.toLowerCase().replace(/[?.!,]/g, ' ').replace(STOP_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

/** Score how well a place matches the query: 0 = no match. */
export function matchScore(place: Place, query: string): number {
  const q = normaliseQuery(query);
  if (!q) return 0;
  const name = place.name.toLowerCase();
  const brand = (place.brand ?? '').toLowerCase();
  // A query that is a kind of place ("chemist", "coffee", "toilets"): every
  // place of that kind matches as well as one with the word in its name, so
  // the nearest one wins rather than the one called "... Chemist".
  const kind = KIND_WORDS.find((k) => k.re.test(q));
  const isKind = !!kind && (kind.categories?.includes(place.category) || !!kind.tag?.test(place.osmTag));
  if (name === q || brand === q) return 1;
  if (brand && (brand.includes(q) || q.includes(brand))) return 0.9;
  if (name.startsWith(q) && !kind) return 0.85;
  // Every query word appears in the name ("tesco express" → "Tesco Express Stratford").
  const words = q.split(' ').filter((w) => w.length > 1);
  if (words.length && words.every((w) => name.includes(w))) return 0.8;
  if (isKind) return 0.8;
  if (words.some((w) => w.length > 3 && name.includes(w))) return 0.4;
  return 0;
}

export interface PlaceHit {
  place: Place;
  score: number;
  straightMeters: number;
  /** Walking distance on the graph (shortest profile), or null if unreachable / not computed. */
  walkMeters: number | null;
}

/**
 * Places matching `query`, nearest first by walking distance. Straight-line
 * distance picks the candidates; the router ranks the closest `routeTop` by
 * real walking distance (a river or railway can make "closest" far away).
 */
export function findPlaces(index: PackIndex, router: Router | null, from: LatLng, query: string, limit = 5, routeTop = 6): PlaceHit[] {
  const scored = index.pack.places
    .map((place) => ({ place, score: matchScore(place, query) }))
    .filter((h) => h.score > 0);
  if (!scored.length) return [];
  const topScore = Math.max(...scored.map((h) => h.score));
  // Keep only the best kind of match: if "Tesco" matches by brand, don't mix in every supermarket.
  const best = scored
    .filter((h) => h.score >= topScore - 0.15)
    .map((h) => ({ ...h, straightMeters: distance(from, h.place), walkMeters: null as number | null }))
    .sort((a, b) => a.straightMeters - b.straightMeters);

  if (router) {
    for (const h of best.slice(0, routeTop)) h.walkMeters = router.walkingDistance(from, h.place);
    const ranked = best.slice(0, routeTop).sort((a, b) => (a.walkMeters ?? Infinity) - (b.walkMeters ?? Infinity));
    return [...ranked, ...best.slice(routeTop)].slice(0, limit);
  }
  return best.slice(0, limit);
}
