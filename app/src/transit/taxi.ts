// Taxi hand-off (F12, ADR-008): open a taxi app with the trip filled in. The
// person checks and books in that app; this app never books, pays or sends
// anything. Needs a connection, like the taxi apps themselves.

import type { LatLng } from '../contracts';

/** Uber's documented universal link: opens the app (or m.uber.com) with pickup and drop-off set. */
export function uberLink(from: LatLng, to: LatLng, toName: string): string {
  const q = new URLSearchParams({
    action: 'setPickup',
    'pickup[latitude]': from.lat.toFixed(6),
    'pickup[longitude]': from.lng.toFixed(6),
    'pickup[nickname]': 'My location',
    'dropoff[latitude]': to.lat.toFixed(6),
    'dropoff[longitude]': to.lng.toFixed(6),
    'dropoff[nickname]': toName,
  });
  return `https://m.uber.com/ul/?${q}`;
}

/** What to tell any driver or minicab office, or paste into another taxi app. */
export function destinationText(toName: string, to: LatLng): string {
  return `${toName} (${to.lat.toFixed(5)}, ${to.lng.toFixed(5)}) https://maps.google.com/?q=${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
}
