// Small, dependency-free geometry helpers shared by every folder.
// Distances in metres, bearings in degrees clockwise from north.

import type { LatLng } from '../contracts';

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distance(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial bearing from a to b, 0..360. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed smallest turn from heading `from` to heading `to`, -180..180 (positive = right). */
export function turnAngle(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Relative bearing of a target, as a clock position (12 = ahead, 3 = right, 9 = left). */
export function clockPosition(heading: number, targetBearing: number): number {
  const rel = (targetBearing - heading + 360) % 360;
  const h = Math.round(rel / 30) % 12;
  return h === 0 ? 12 : h;
}

/** The point `meters` along the bearing from `p`. */
export function destination(p: LatLng, bearingDeg: number, meters: number): LatLng {
  const d = meters / R;
  const b = rad(bearingDeg);
  const lat1 = rad(p.lat);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = rad(p.lng) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: ((deg(lng2) + 540) % 360) - 180 };
}

/**
 * A flat x/y projection in metres around an origin (equirectangular). Accurate
 * to well under a metre across a 2 km area pack, and cheap. x = east, y = north.
 */
export function makeProjection(origin: LatLng) {
  const kx = (Math.PI / 180) * R * Math.cos(rad(origin.lat));
  const ky = (Math.PI / 180) * R;
  return {
    toXY: (p: LatLng) => ({ x: (p.lng - origin.lng) * kx, y: (p.lat - origin.lat) * ky }),
    toLatLng: (x: number, y: number): LatLng => ({ lat: origin.lat + y / ky, lng: origin.lng + x / kx }),
  };
}

/** Distance from p to segment a-b in metres, and the closest point's fraction t along it. */
export function distanceToSegment(p: LatLng, a: LatLng, b: LatLng): { meters: number; t: number } {
  const proj = makeProjection(p);
  const A = proj.toXY(a);
  const B = proj.toXY(b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / len2));
  const cx = A.x + t * dx;
  const cy = A.y + t * dy;
  return { meters: Math.hypot(cx, cy), t };
}

/** Distance from p to a polyline, in metres (off-route checks, F2). */
export function distanceToPolyline(p: LatLng, line: LatLng[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return distance(p, line[0]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(p, line[i - 1], line[i]).meters);
  return best;
}

/** Total length of a polyline in metres. */
export function polylineLength(line: LatLng[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += distance(line[i - 1], line[i]);
  return s;
}

/** The point `meters` along a polyline (clamped to its ends), and the bearing there. */
export function pointAlong(line: LatLng[], meters: number): { point: LatLng; bearing: number } {
  if (line.length < 2) return { point: line[0], bearing: 0 };
  let left = Math.max(0, meters);
  for (let i = 1; i < line.length; i++) {
    const seg = distance(line[i - 1], line[i]);
    const b = bearing(line[i - 1], line[i]);
    if (left <= seg || i === line.length - 1) {
      const f = seg === 0 ? 0 : Math.min(1, left / seg);
      return {
        point: { lat: line[i - 1].lat + (line[i].lat - line[i - 1].lat) * f, lng: line[i - 1].lng + (line[i].lng - line[i - 1].lng) * f },
        bearing: b,
      };
    }
    left -= seg;
  }
  return { point: line[line.length - 1], bearing: 0 };
}
