// Real GPS as a PositionSource, through the browser's Geolocation API.
// Works in a phone's browser (needs https or localhost). The simulated walk
// (src/sim) implements the same interface, so navigation can't tell them apart.
//
// GPS itself needs no data connection: the phone listens to satellites.

import type { Position, PositionSource } from '../contracts';

export function createGpsSource(): PositionSource {
  let watchId: number | null = null;
  let last: Position | null = null;
  const listeners = new Set<(p: Position) => void>();

  return {
    kind: 'gps',
    start() {
      if (watchId != null || typeof navigator === 'undefined' || !navigator.geolocation) return;
      watchId = navigator.geolocation.watchPosition(
        (g) => {
          last = {
            lat: g.coords.latitude,
            lng: g.coords.longitude,
            accuracy: g.coords.accuracy,
            // Browser heading is direction of travel and is null/NaN when standing still.
            heading: g.coords.heading != null && !Number.isNaN(g.coords.heading) ? g.coords.heading : null,
            speed: g.coords.speed,
            timestamp: g.timestamp,
            source: 'gps',
          };
          for (const l of listeners) l(last);
        },
        (err) => console.warn('GPS error:', err.message),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
      );
    },
    stop() {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => last,
  };
}

/** True when this browser can give real positions at all. */
export const gpsAvailable = () => typeof navigator !== 'undefined' && 'geolocation' in navigator;
