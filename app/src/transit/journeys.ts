// Public transport journeys (online): TfL's Journey Planner, free and keyless.
// Bus, Tube, DLR, Overground, Elizabeth line and rail, with walking between,
// planned at a slow walking pace, and step-free when the route type asks.
//
//   const r = await planJourneys(index, here, dest, { stepFree: true });
//   r.ok ? r.journeys : r.message
//
// Everything said about a journey comes from TfL's answer (principle 2).
// Offline, this says so and the caller falls back to walking.

import type { BusStop, LatLng } from '../contracts';
import { onlineFetch } from '../net/online';
import type { PackIndex } from '../pack/pack';

const TFL = 'https://api.tfl.gov.uk';

export type LegMode = 'walking' | 'bus' | 'tube' | 'dlr' | 'overground' | 'elizabeth-line' | 'national-rail' | 'tram' | 'other';

export interface LegPoint extends LatLng {
  name: string;
  naptanId: string | null;
  /** "Stop J" for buses. */
  indicator: string | null;
}

export interface Leg {
  mode: LegMode;
  minutes: number;
  /** TfL's own summary: "108 bus to Stratford City Bus Station". */
  summary: string;
  from: LegPoint;
  to: LegPoint;
  /** Line number or name: "108", "Central". */
  line: string | null;
  /** "Stratford International Station" */
  towards: string | null;
  /** Stops passed, ending at `to` (names; positions where our pack knows them). */
  stops: Array<{ id: string | null; name: string; at: LatLng | null }>;
  /** The vehicle's or walk's path, for the map. */
  path: LatLng[];
  departure: Date;
  arrival: Date;
  disrupted: boolean;
}

export interface Journey {
  minutes: number;
  start: Date;
  arrive: Date;
  legs: Leg[];
  /** Pence, when TfL gives a fare. */
  farePence: number | null;
}

const MODES: LegMode[] = ['walking', 'bus', 'tube', 'dlr', 'overground', 'elizabeth-line', 'national-rail', 'tram'];
const asMode = (m: string): LegMode => (MODES.includes(m as LegMode) ? (m as LegMode) : 'other');

export const MODE_ICON: Record<LegMode, string> = {
  walking: 'directions_walk', bus: 'directions_bus', tube: 'subway', dlr: 'train', overground: 'train',
  'elizabeth-line': 'train', 'national-rail': 'train', tram: 'tram', other: 'commute',
};
export const MODE_WORD: Record<LegMode, string> = {
  walking: 'Walk', bus: 'Bus', tube: 'Tube', dlr: 'DLR', overground: 'Overground', 'elizabeth-line': 'Elizabeth line',
  'national-rail': 'Train', tram: 'Tram', other: 'Transport',
};
/** Vehicles you ride stop by stop with GPS overhead (the countdown works). */
export const isRoadVehicle = (m: LegMode) => m === 'bus' || m === 'tram';

const clock = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const title = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bLondon$/i, '').replace(/,\s*$/, '').trim();

/* eslint-disable @typescript-eslint/no-explicit-any */
function point(p: any): LegPoint {
  const raw = String(p?.commonName ?? 'Unknown');
  // TfL names street addresses in capitals ("5 THORNTON STREET, LONDON").
  const name = raw === raw.toUpperCase() ? title(raw) : raw;
  return { name, lat: Number(p?.lat), lng: Number(p?.lon), naptanId: p?.naptanId ?? null, indicator: p?.stopLetter ? `Stop ${p.stopLetter}` : null };
}

function parseLine(s: string | undefined): LatLng[] {
  try {
    return (JSON.parse(s ?? '[]') as number[][]).map(([lat, lng]) => ({ lat, lng }));
  } catch {
    return [];
  }
}

function parse(index: PackIndex, data: any): Journey[] {
  const stopsById = new Map<string, BusStop>(index.pack.busStops.map((s) => [s.id, s]));
  return (data?.journeys ?? []).map((j: any) => ({
    minutes: Number(j.duration),
    start: new Date(j.startDateTime),
    arrive: new Date(j.arrivalDateTime),
    farePence: j.fare?.totalCost ?? null,
    legs: (j.legs ?? []).map((l: any): Leg => {
      const mode = asMode(l.mode?.id ?? 'other');
      const ro = l.routeOptions?.[0] ?? {};
      const to = point(l.arrivalPoint);
      const stops = (l.path?.stopPoints ?? []).map((s: any) => {
        const known = s.id ? stopsById.get(s.id) : undefined;
        return { id: s.id ?? null, name: String(s.name ?? ''), at: known ? { lat: known.lat, lng: known.lng } : null };
      });
      // The last stop is where you get off: TfL gives its position on the leg.
      if (stops.length) stops[stops.length - 1].at ??= { lat: to.lat, lng: to.lng };
      return {
        mode,
        minutes: Number(l.duration),
        summary: String(l.instruction?.summary ?? ''),
        from: point(l.departurePoint),
        to,
        line: mode === 'walking' ? null : (ro.name || null),
        towards: mode === 'walking' ? null : (ro.directions?.[0] || null),
        stops: mode === 'walking' ? [] : stops,
        path: parseLine(l.path?.lineString),
        departure: new Date(l.departureTime),
        arrival: new Date(l.arrivalTime),
        disrupted: !!l.isDisrupted,
      };
    }),
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function planJourneys(
  index: PackIndex,
  from: LatLng,
  to: LatLng,
  opts: { stepFree?: boolean } = {},
): Promise<{ ok: true; journeys: Journey[] } | { ok: false; offline: boolean; message: string }> {
  const q = new URLSearchParams({
    mode: 'bus,tube,dlr,overground,elizabeth-line,national-rail,tram,walking',
    walkingSpeed: 'Slow',
    // TfL accepts several: no stairs, and step-free to the vehicle, for the step-free route type.
    accessibilityPreference: opts.stepFree ? 'NoSolidStairs,NoEscalators,StepFreeToVehicle' : 'NoRequirements',
  });
  const url = `${TFL}/Journey/JourneyResults/${from.lat.toFixed(6)},${from.lng.toFixed(6)}/to/${to.lat.toFixed(6)},${to.lng.toFixed(6)}?${q}`;
  const r = await onlineFetch(url, { timeoutMs: 12000 });
  if (!r.ok) {
    return {
      ok: false,
      offline: r.reason === 'offline',
      message: r.reason === 'offline' ? 'Public transport routes need a connection. Walking directions still work offline.' : 'TfL journey planning is not available right now.',
    };
  }
  const journeys = parse(index, r.data).filter((j) => j.legs.length && j.legs.some((l) => l.mode !== 'walking')).slice(0, 4);
  if (!journeys.length) return { ok: false, offline: false, message: 'TfL found no public transport route for this trip. Walking may be quicker.' };
  return { ok: true, journeys };
}

/** "bus 108", "the Central line", "the Elizabeth line", "the DLR", "a Southeastern train". */
export function legName(l: Leg): string {
  const line = l.line?.trim() || null;
  switch (l.mode) {
    case 'bus':
      return `bus ${line ?? ''}`.trim();
    case 'tube':
      return line ? `the ${line.replace(/ line$/i, '')} line` : 'the Tube';
    case 'elizabeth-line':
      return 'the Elizabeth line';
    case 'dlr':
      return 'the DLR';
    case 'overground':
      return line ? `the ${line.replace(/ line$/i, '')} line, Overground` : 'the Overground';
    case 'national-rail':
      return line ? `a ${line} train` : 'a train';
    case 'tram':
      return 'the tram';
    default:
      return line ?? 'transport';
  }
}

/** One spoken sentence for a whole journey, from TfL's data only. */
export function journeySentence(j: Journey): string {
  const parts = j.legs.map((l) => {
    if (l.mode === 'walking') return `walk ${l.minutes} minute${l.minutes === 1 ? '' : 's'}`;
    const n = l.stops.length;
    return `${legName(l)} for ${n} stop${n === 1 ? '' : 's'} to ${l.to.name}`;
  });
  return `${j.minutes} minutes, leaving at ${clock(j.start)}, arriving ${clock(j.arrive)}: ${parts.join(', then ')}.${j.legs.some((l) => l.disrupted) ? ' TfL reports disruption on this route.' : ''}`;
}

/** What to say when a vehicle leg starts. */
export function boardSentence(l: Leg): string {
  const at = [l.from.name, l.from.indicator].filter(Boolean).join(', ');
  const n = l.stops.length;
  return `At ${at}, take ${legName(l)}${l.towards ? ` towards ${l.towards}` : ''}. ${n} stop${n === 1 ? '' : 's'} to ${l.to.name}.`;
}

export const fmtClock = clock;
