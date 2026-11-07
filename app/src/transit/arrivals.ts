// Bus arrivals (F9): live from TfL when online, the usual frequency from the
// area pack when offline, and always clear about which one it is
// (principles 2 and 3).
//
//   const r = await busArrivals(index, stop, { line: '25' });
//   r.say  // "Live: the 25 to Ilford in 3 minutes, then 11 minutes."
//          // "Live times need a connection. The 25 usually comes every 8 to 12 minutes. That is not live."

import type { BusRoute, BusStop, ToolResult } from '../contracts';
import { onlineFetch } from '../net/online';
import type { PackIndex } from '../pack/pack';

const TFL = 'https://api.tfl.gov.uk';

interface TflArrival {
  lineName: string;
  destinationName: string;
  timeToStation: number;
  platformName?: string;
}

export interface Arrival {
  line: string;
  destination: string;
  minutes: number;
}

/** Routes in the pack that call at this stop. */
export function routesAt(index: PackIndex, stop: BusStop): BusRoute[] {
  return index.pack.busRoutes.filter((r) => r.stops.includes(stop.id));
}

function minutesWords(m: number): string {
  if (m <= 0) return 'due now';
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** The offline answer: usual gaps, labelled as estimates and as not live. */
export function frequencySentence(index: PackIndex, stop: BusStop, line?: string): string {
  const routes = routesAt(index, stop).filter((r) => !line || r.name.toLowerCase() === line.toLowerCase());
  const known = routes.filter((r) => r.frequencyMinutes);
  if (!known.length) {
    const names = [...new Set(routes.map((r) => r.name))];
    return names.length
      ? `I don't have times for ${names.join(', ')} offline.`
      : `I don't have bus times for this stop offline.`;
  }
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const r of known) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    const f = r.frequencyMinutes!;
    parts.push(`the ${r.name} about every ${f.min} to ${f.max} minutes`);
  }
  const estimated = known.some((r) => r.frequencySource === 'estimated-from-arrivals');
  return `Usually ${parts.join(', ')}. That is not live${estimated ? ', and it is an estimate from when the map was downloaded' : ''}.`;
}

/** Live arrivals at a stop, or the offline fallback. Never throws. */
export async function busArrivals(index: PackIndex, stop: BusStop, opts: { line?: string; max?: number } = {}): Promise<ToolResult> {
  const max = opts.max ?? 3;
  const label = [stop.name, stop.indicator].filter(Boolean).join(', ');
  if (!stop.naptanId) return { ok: true, intent: 'busArrivals', say: `${label}: ${frequencySentence(index, stop, opts.line)}`, offlineFallback: true };

  const r = await onlineFetch<TflArrival[]>(`${TFL}/StopPoint/${encodeURIComponent(stop.naptanId)}/Arrivals`, { timeoutMs: 6000 });
  if (!r.ok) {
    const why = r.reason === 'offline' ? 'Live times need a connection.' : 'Live times are not available right now.';
    return { ok: true, intent: 'busArrivals', say: `${why} ${frequencySentence(index, stop, opts.line)}`, offlineFallback: true };
  }

  const arrivals: Arrival[] = r.data
    .filter((a) => !opts.line || a.lineName.toLowerCase() === opts.line.toLowerCase())
    .map((a) => ({ line: a.lineName, destination: a.destinationName, minutes: Math.floor(a.timeToStation / 60) }))
    .sort((a, b) => a.minutes - b.minutes);

  if (!arrivals.length)
    return { ok: true, intent: 'busArrivals', say: `Live: no buses${opts.line ? ` on the ${opts.line}` : ''} are shown for ${label} right now.`, data: [] };

  // Group by line + destination: "the 25 to Ilford in 3 minutes, then 11 minutes".
  const groups = new Map<string, Arrival[]>();
  for (const a of arrivals) {
    const k = `${a.line}|${a.destination}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const parts = [...groups.values()].slice(0, max).map((g) => {
    const [first, ...rest] = g;
    const then = rest.length ? `, then ${rest.slice(0, 1).map((a) => minutesWords(a.minutes)).join('')}` : '';
    return `the ${first.line} to ${first.destination} ${first.minutes <= 0 ? 'due now' : `in ${minutesWords(first.minutes)}`}${then}`;
  });
  return { ok: true, intent: 'busArrivals', say: `Live at ${label}: ${parts.join('; ')}.`, data: arrivals };
}
