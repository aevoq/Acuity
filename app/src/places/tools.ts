// The tool layer (ADR-004): every question is answered here, from the area
// pack plus position and heading. Whoever picks the tool, the offline keyword
// matcher, a local model or Gemini's function calling, the answer text is
// built from data by these functions, never written freely by a model.
//
//   const tools = createTools({ index, router });
//   tools.nearest({ query: 'tesco' }, here)  → ToolResult
//   tools.aroundMe({}, here)
//   tools.leftRight({ side: 'left' }, here)
//   tools.whereAmI({}, here)
//   tools.nearestBusStop({}, here)
//
// Directions: clock positions when we know which way the person faces
// (heading), compass words when we don't. Never a guess dressed as fact.

import type { IntentName, LatLng, Place, Position, Route, ToolResult } from '../contracts';
import { bearing, clockPosition, distance } from '../geo/geo';
import type { Router } from '../nav/router';
import type { PackIndex } from '../pack/pack';
import { compassWord } from '../nav/instructions';
import { findPlaces } from './search';

const AROUND_ME_METERS = 50;
const SIDE_METERS = 60;
const POOR_GPS_METERS = 30;

/** "40 metres", rounded the way people say it. */
export function metresWords(m: number): string {
  if (m < 15) return 'a few metres';
  if (m < 100) return `${Math.round(m / 5) * 5} metres`;
  if (m < 1000) return `${Math.round(m / 10) * 10} metres`;
  return `${(m / 1000).toFixed(1).replace(/\.0$/, '')} kilometres`;
}

/** "at 2 o'clock" when heading is known, "to the north-east" otherwise. */
export function directionWords(from: Position, to: LatLng): string {
  const b = bearing(from, to);
  if (from.heading != null) return `at ${clockPosition(from.heading, b)} o'clock`;
  return `to the ${compassWord(b)}`;
}

/** A sentence about poor accuracy, or '' when GPS is fine (principle 2). */
function accuracyCaveat(p: Position): string {
  return p.accuracy > POOR_GPS_METERS ? ` GPS is poor, accurate to about ${metresWords(p.accuracy)}, so treat this as rough.` : '';
}

const ok = (intent: IntentName, say: string, data?: unknown, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, intent, say, data, ...extra });
const fail = (intent: IntentName, say: string): ToolResult => ({ ok: false, intent, say });

export interface ToolDeps {
  index: PackIndex;
  router: Router | null;
}

export function createTools({ index, router }: ToolDeps) {
  return {
    /** "Where's the nearest Tesco / pharmacy / toilet?" */
    nearest({ query }: { query: string }, here: Position): ToolResult {
      if (!query?.trim()) return fail('nearest', 'What kind of place are you looking for?');
      const hits = findPlaces(index, router, here, query, 3);
      if (!hits.length) return fail('nearest', `I couldn't find ${query} in the downloaded area.`);
      const h = hits[0];
      const walk = h.walkMeters != null ? `${metresWords(h.walkMeters)} walk` : `${metresWords(h.straightMeters)} away in a straight line`;
      return ok('nearest', `The nearest is ${h.place.name}, about ${walk}, ${directionWords(here, h.place)}.${accuracyCaveat(here)}`, hits);
    },

    /** "What's around me?" Places within 50 m, closest first, at most 5. */
    aroundMe(_args: Record<string, never> | undefined, here: Position): ToolResult {
      let radius = AROUND_ME_METERS;
      let near = index.placesNear(here, radius, 5);
      if (!near.length) {
        radius = 150;
        near = index.placesNear(here, radius, 3);
      }
      if (!near.length) return ok('aroundMe', `There are no named places within ${radius} metres.${accuracyCaveat(here)}`, []);
      const list = near.map(({ place, meters }) => `${place.name}, ${metresWords(meters)} ${directionWords(here, place)}`);
      const lead = radius === AROUND_ME_METERS ? `Within ${radius} metres` : `Nothing within ${AROUND_ME_METERS} metres. Within ${radius}`;
      return ok('aroundMe', `${lead}: ${list.join('; ')}.${accuracyCaveat(here)}`, near);
    },

    /** "What's on my left / right / ahead / behind?" Needs to know which way the person faces (ADR-005). */
    leftRight({ side }: { side: 'left' | 'right' | 'ahead' | 'behind' }, here: Position): ToolResult {
      if (here.heading == null)
        return fail('leftRight', "I don't know which way you are facing. Point the phone forward, or start walking, and ask again.");
      const range = { ahead: [-45, 45], right: [45, 135], behind: [135, 225], left: [225, 315] }[side] ?? [-45, 45];
      const inSide = (p: Place) => {
        let rel = (bearing(here, p) - here.heading! + 360) % 360;
        if (side === 'ahead' && rel > 180) rel -= 360;
        return rel >= range[0] && rel < range[1];
      };
      const hits = index.placesNear(here, SIDE_METERS, 20).filter((r) => inSide(r.place)).slice(0, 4);
      if (!hits.length) return ok('leftRight', `Nothing named on your ${side} within ${SIDE_METERS} metres.${accuracyCaveat(here)}`, []);
      const list = hits.map(({ place, meters }) => `${place.name}, ${metresWords(meters)}`);
      const where = side === 'ahead' || side === 'behind' ? side : `on your ${side}`;
      return ok('leftRight', `${where[0].toUpperCase()}${where.slice(1)}: ${list.join('; ')}.${accuracyCaveat(here)}`, hits);
    },

    /** "Where am I?" Nearest street plus nearest landmark. */
    whereAmI(_args: Record<string, never> | undefined, here: Position): ToolResult {
      if (here.accuracy > 100) return fail('whereAmI', `I can't tell where you are. GPS is only accurate to about ${metresWords(here.accuracy)}.`);
      const street = index.streetAt(here, 80);
      const landmark = index.placesNear(here, 80, 1)[0];
      // "on" only when really on it; "near" up to 80 m (inside a park, a station, a plaza).
      const where = !street ? 'You are not near a named street.' : street.meters <= 25 ? `You are on ${street.name}.` : `You are near ${street.name}.`;
      const near = landmark ? ` Nearest place: ${landmark.place.name}, ${metresWords(landmark.meters)} ${directionWords(here, landmark.place)}.` : '';
      return ok('whereAmI', `${where}${near}${accuracyCaveat(here)}`, { street: street?.name ?? null, landmark: landmark?.place ?? null });
    },

    /**
     * "Where's the nearest bench?" On a walk, a bench on the route ahead first
     * ("on your route in about 120 metres"), else the nearest anywhere.
     */
    nearestBench({ route, progress }: { route?: Route | null; progress?: number } = {}, here: Position): ToolResult {
      const benches = index.pack.benches;
      if (!benches.length) return fail('nearest', 'There are no benches in the downloaded map.');
      if (route && route.path.length > 1) {
        // Distance along the route of each path vertex, to place benches on it.
        const cum = [0];
        for (let i = 1; i < route.path.length; i++) cum.push(cum[i - 1] + distance(route.path[i - 1], route.path[i]));
        const done = progress ?? 0;
        let best: { along: number } | null = null;
        for (const b of benches) {
          if (distance(here, b) > 900) continue;
          let bi = 0;
          let bd = Infinity;
          for (let i = 0; i < route.path.length; i++) {
            const d = distance(b, route.path[i]);
            if (d < bd) [bi, bd] = [i, d];
          }
          if (bd <= 20 && cum[bi] > done + 5 && (!best || cum[bi] < best.along)) best = { along: cum[bi] };
        }
        if (best) return ok('nearest', `There's a bench on your route in about ${metresWords(best.along - done)}.`, best);
      }
      let near: LatLng | null = null;
      let nd = Infinity;
      for (const b of benches) {
        const d = distance(here, b);
        if (d < nd) [near, nd] = [b, d];
      }
      if (!near || nd > 1500) return fail('nearest', 'There is no bench within 1.5 kilometres in the downloaded map.');
      return ok('nearest', `The nearest bench is about ${metresWords(nd)} ${directionWords(here, near)}${route ? ', not on your route' : ''}.${accuracyCaveat(here)}`, { bench: near, meters: nd });
    },

    /** "How far is it? When will I arrive? What's next?" From the live route. */
    routeStatus({ route, remaining, next }: { route: Route | null; remaining: number; next: string | null }): ToolResult {
      if (!route) return fail('nextStep', "You're not on a route yet. Tell me where you'd like to go.");
      const mins = Math.max(1, Math.round(remaining / 1.4 / 60));
      const at = new Date(Date.now() + (remaining / 1.4) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return ok('nextStep', `${metresWords(remaining)} to ${route.destinationName}, about ${mins} minute${mins === 1 ? '' : 's'}: you should arrive around ${at}.${next ? ` Next: ${next}` : ''}`);
    },

    /** "Where's the nearest bus stop?" With its letter, direction and buses. */
    nearestBusStop(_args: Record<string, never> | undefined, here: Position): ToolResult {
      const stops = index.busStopsNear(here, 600, 2);
      if (!stops.length) return fail('nearestBusStop', 'There is no bus stop within 600 metres in the downloaded area.');
      const { stop, meters } = stops[0];
      const label = [stop.name, stop.indicator, stop.towards].filter(Boolean).join(', ');
      const buses = stop.lines?.length ? ` Buses: ${stop.lines.join(', ')}.` : '';
      return ok('nearestBusStop', `The nearest bus stop is ${label}, about ${metresWords(meters)} ${directionWords(here, stop)}.${buses}${accuracyCaveat(here)}`, stops);
    },
  };
}

export type Tools = ReturnType<typeof createTools>;

/**
 * The same tools as Gemini function declarations (F7), so the online assistant
 * picks a tool and our code still writes the answer. `nextStep`, `repeat` and
 * `help` come from guidance and the app shell, so they are declared here too.
 */
export const TOOL_DECLARATIONS = [
  {
    name: 'nearest',
    description: 'Find the nearest place of a kind or name (a shop, brand, pharmacy, toilet, cafe, station) and how far it is to walk.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Place name, brand or kind, e.g. "Tesco", "pharmacy", "toilets".' } }, required: ['query'] },
  },
  { name: 'aroundMe', description: "List named places within about 50 metres of the user, nearest first.", parameters: { type: 'object', properties: {} } },
  {
    name: 'leftRight',
    description: "List named places on one side of the user, relative to the way they are facing.",
    parameters: { type: 'object', properties: { side: { type: 'string', enum: ['left', 'right', 'ahead', 'behind'] } }, required: ['side'] },
  },
  { name: 'whereAmI', description: 'Say which street the user is on and the nearest landmark.', parameters: { type: 'object', properties: {} } },
  { name: 'nearestBusStop', description: 'Find the nearest bus stop, its stop letter, direction and buses.', parameters: { type: 'object', properties: {} } },
  {
    name: 'busArrivals',
    description: 'When the next buses come at the nearest bus stop (live when online, usual frequency offline).',
    parameters: { type: 'object', properties: { line: { type: 'string', description: 'Optional bus number, e.g. "25".' } } },
  },
  {
    name: 'navigateTo',
    description: 'Start walking directions to a place.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Place name, brand or kind.' } }, required: ['query'] },
  },
  { name: 'nextStep', description: 'Say the next walking instruction on the current route.', parameters: { type: 'object', properties: {} } },
  { name: 'repeat', description: 'Repeat the last thing the app said.', parameters: { type: 'object', properties: {} } },
  { name: 'help', description: 'Open the emergency and help options (call 999, text location to a contact).', parameters: { type: 'object', properties: {} } },
] as const;
