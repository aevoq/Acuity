// Run one Intent against the tool layer. Whoever produced the Intent (a
// button, the offline matcher, Gemini) the answer comes from the same tools.

import type { Intent, Position, ToolResult } from '../contracts';
import type { Guidance } from '../nav/guidance';
import type { PackIndex } from '../pack/pack';
import type { Tools } from '../places/tools';
import { busArrivals } from '../transit/arrivals';

export interface IntentDeps {
  index: PackIndex;
  tools: Tools;
  here: Position;
  guidance: Guidance | null;
  lastSaid: string | null;
  /** Start navigation to a place query; returns what to say. */
  navigateTo: (query: string) => ToolResult;
  openHelp: () => void;
}

export async function runIntent(intent: Intent, d: IntentDeps): Promise<ToolResult> {
  switch (intent.name) {
    case 'nearest':
      return d.tools.nearest({ query: intent.query ?? '' }, d.here);
    case 'aroundMe':
      return d.tools.aroundMe(undefined, d.here);
    case 'leftRight':
      return d.tools.leftRight({ side: intent.side ?? 'ahead' }, d.here);
    case 'whereAmI':
      return d.tools.whereAmI(undefined, d.here);
    case 'nearestBusStop':
      return d.tools.nearestBusStop(undefined, d.here);
    case 'busArrivals': {
      const stop = d.index.busStopsNear(d.here, 600, 1)[0]?.stop;
      if (!stop) return { ok: false, intent: 'busArrivals', say: 'There is no bus stop within 600 metres.' };
      return busArrivals(d.index, stop, { line: intent.line });
    }
    case 'navigateTo':
      return d.navigateTo(intent.query ?? '');
    case 'nextStep':
      return { ok: true, intent: 'nextStep', say: d.guidance?.nextStep() ?? 'There is no route yet. Ask for a place first.' };
    case 'repeat':
      return { ok: true, intent: 'repeat', say: d.guidance?.lastPrompt() ?? d.lastSaid ?? 'Nothing to repeat yet.' };
    case 'help':
      d.openHelp();
      return { ok: true, intent: 'help', say: 'Help options are open: call 999, text your location, or call your contact. Nothing happens until you confirm.' };
    default:
      return {
        ok: false,
        intent: 'unknown',
        say: "I didn't catch that. You can ask: where am I, what's around me, what's on my left, nearest Tesco, or when is the next bus.",
      };
  }
}
