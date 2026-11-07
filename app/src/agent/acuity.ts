// Acuity: the voice agent that runs the whole journey, built on Abdullah's
// assistant. She asks where you want to go, finds it, offers the nearest,
// sets up the route, starts it, and stays on "Hey Acuity" during the walk.
//
// Grounded (PRD principle 2, ADR-004): every fact she says comes from the
// app's own data and tools (the area pack, the route, TfL). A model only
// picks WHICH tool when the keyword rules can't (Abdullah's gemma3 offline,
// Gemini online); it never writes the answer.
//
// Follow-ups: when there is an obvious next step she asks one short question
// ("Shall I take you there?") and listens for the answer without the wake
// word. Otherwise she ends with "Say 'Hey Acuity' if you need me."

import type { Intent, Position, Route, RouteProfileId, ToolResult } from '../contracts';
import { geminiPickTool } from '../net/gemini';
import type { Tools } from '../places/tools';
import { quickMatch } from '../app/quickMatch';
import { agentIntent } from '../vision/sidecar';
import { fmtDist, targetName, walkMinutes, type ResultItem, type Target } from '../app/ui/model';
import { PROFILE_LABELS } from '../nav/costs';

export type Stage = 'explore' | 'results' | 'place' | 'nav' | 'ride' | 'rail' | 'arrived';

export interface AcuityView {
  stage: Stage;
  results: ResultItem[];
  sel: Target | null;
  route: Route | null;
  remaining: number;
  nextInstruction: string | null;
  progress: number;
  here: Position;
  online: boolean;
  travel: 'walk' | 'transit' | 'taxi';
}

export interface AcuityDeps {
  view(): AcuityView;
  tools: Tools;
  /** Say something (live region + voice). `queue` waits for what is already playing. */
  say(text: string, opts?: { queue?: boolean }): void;
  /** Show who said what. */
  caption(who: 'you' | 'acuity', text: string): void;
  /** Visual mirror: type the words into the search bar, as a sighted user would. */
  typeQuery(text: string): Promise<void>;
  /** Search and show results quietly (Acuity does the talking). Returns the count. */
  search(q: string): Promise<number>;
  /** Open a place card quietly (route planned). */
  choose(t: Target): void;
  setProfile(p: RouteProfileId): void;
  startWalk(): void;
  endWalk(): void;
  showTransit(): void;
  startJourney(): void;
  openTaxi(): void;
  openCamera(light: boolean): void;
  /** Look at the traffic light through the camera (in the background) and say what it shows. */
  checkLight(): Promise<{ sentence: string }>;
  /** Keep watching the light and announce changes (true), or stop (false). */
  watchLight(on: boolean): void;
  /** Look ahead with the camera and answer with Abdullah's camera assistant. */
  describeScene(question: string): Promise<string>;
  openHelp(): void;
  /** Run a standard intent through runIntent (tools + bus times). */
  runIntent(i: Intent): Promise<ToolResult>;
  /** Listen for the reply without the wake word. */
  listen(): void;
  /** Back to waiting for "Hey Acuity". */
  rest(): void;
}

type Pending =
  | { kind: 'destination' }
  | { kind: 'offer'; index: number }
  | { kind: 'start' }
  | { kind: 'startJourney' }
  | { kind: 'goInstead'; target: Target }
  | { kind: 'pickNearby'; items: Target[] }
  | { kind: 'confirmStop' }
  | { kind: 'watchLight' };

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|please|go ahead|do it|let'?s go|go|start|correct|that one|sounds good|alright|yes please|right)\b/;
const NO = /^(no|nope|nah|not that|not now|no thanks|don'?t|cancel|never ?mind)\b/;
const NEXT = /\b(next|another|other|different|something else|the others?)\b/;
const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|1st|number one|the one)\b/, 0],
  [/\b(second|2nd|number two)\b/, 1],
  [/\b(third|3rd|number three)\b/, 2],
  [/\b(fourth|4th|number four)\b/, 3],
  [/\b(fifth|5th|number five)\b/, 4],
];
const PROFILES: Array<[RegExp, RouteProfileId]> = [
  [/\b(fewest|fewer|less|least|no|avoid)\s+(road\s+)?crossings?\b|\bfewer roads\b/, 'fewestCrossings'],
  [/\bstep[- ]?free\b|\bno (steps|stairs)\b|\bwheelchair\b|\bavoid (steps|stairs)\b/, 'stepFree'],
  [/\bmain roads?\b|\bbusy roads?\b|\bwell lit\b|\blighter\b|\bsafer\b/, 'mainRoads'],
  [/\bshortest\b|\bquickest\b|\bfastest walk\b/, 'shortest'],
  [/\brest stops?\b|\bbenches\b|\bplaces to sit\b/, 'restStops'],
];

/** What the person can say instead of "start", leaving out the route type they already have. */
const ROUTE_CHOICES: Array<[RouteProfileId, string]> = [
  ['shortest', 'shortest'],
  ['fewestCrossings', 'fewest crossings'],
  ['stepFree', 'step-free'],
  ['mainRoads', 'main roads'],
  ['restStops', 'rest stops'],
];
function startOrChoose(current: RouteProfileId): string {
  const others = ROUTE_CHOICES.filter(([id]) => id !== current).map(([, words]) => words);
  return `Say "start" to begin. Or choose another route: ${others.join(', ')}, or go by bus.`;
}
function routeSummary(r: Route): string {
  const cross = `${r.crossings} crossing${r.crossings === 1 ? '' : 's'}${r.crossings ? `, ${r.signalledCrossings} with signals` : ''}`;
  return `${walkMinutes(r.lengthMeters)} minutes on foot, ${cross}.`;
}

/** Questions answered directly, never taken as a destination ("where's the nearest bench" is not a place to search). */
const QUESTION_WORDS = /\b(bench|benches|sit down|somewhere to sit|how far|how long|when (will|do) i|what do you see|describe|in front of me|around me|where am i|on my (left|right)|stop|cancel|traffic lights?|signal|green man|red man)\b/;
/** "Is the light red?", "can you check the traffic light", "is it the green man?" */
const LIGHT = /\b(traffic lights?|the lights?|signals?|green man|red man|is it (red|green)|(red|green) light|crossing lights?|pedestrian lights?)\b/;
/** "What's in front of me?", "what does the sign say?" */
/**
 * The camera only when the person asks Acuity to LOOK. "What's around me", "what's ahead",
 * "what's in front of me" are answered from the map (the pack), never by opening the camera.
 */
const SCENE = /\b(what do you see|what can you see|can you see|what are you seeing|(take a )?look (ahead|around|at|in front|for me)|use (the|your) camera|with the camera|read (the|this|that|a) sign|what does (the|this|that) sign say|describe what you see|describe (the )?scene|what colou?r is)\b/;

const norm = (t: string) => t.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
/** How to call her back: the wake word works during a journey; elsewhere the Talk button. */
const closingFor = (stage: Stage) => (stage === 'nav' || stage === 'ride' || stage === 'rail' ? "Say 'Hey Acuity' if you need me." : 'Tap Talk if you need me.');

/** Words that make a destination out of "I want to go to the Tesco on the high street". */
function destinationWords(t: string): string {
  return t
    .replace(/^(hey |hi |okay |ok )?(acuity[, ]*)?/, '')
    .replace(/^(i('d| would)? (like|want) to go to|i need to go to|i'?m going to|take me to|go to|navigate to|directions to|get me to|walk me to|find( me)?|let'?s go to|can you take me to|how do i get to)\s+/, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+please$/, '')
    .trim();
}

export function createAcuity(d: AcuityDeps) {
  let pending: Pending | null = null;

  const speak = (text: string, queue = false) => d.say(text, { queue });
  /** Ask a follow-up and listen for the answer. */
  const ask = (text: string, p: Pending, queue = false) => {
    pending = p;
    speak(text, queue);
    d.listen();
  };
  const close = (text: string, queue = false) => {
    pending = null;
    const c = closingFor(d.view().stage);
    speak(text ? `${text} ${c}` : c, queue);
    d.rest();
  };

  // ---------------------------------------------------------------- destinations
  async function findDestination(words: string) {
    const q = destinationWords(norm(words)) || words;
    await d.typeQuery(q);
    const n = await d.search(q);
    if (!n) return ask(`I couldn't find ${q}${d.view().online ? '' : ' in the downloaded area'}. Where else would you like to go?`, { kind: 'destination' });
    offer(0);
  }

  function offer(i: number) {
    const v = d.view();
    const r = v.results[i];
    if (!r) return ask("That's all I found. Where else would you like to go?", { kind: 'destination' });
    const n = v.results.length;
    const lead = i === 0 ? `I found ${n} ${n === 1 ? 'place' : 'places'}. The nearest is` : 'The next is';
    const how = r.far ? `${fmtDist(r.walk)} away, outside the walking area, so I'd find you a bus or train` : `about ${fmtDist(r.walk)}, a ${walkMinutes(r.walk)}-minute walk`;
    ask(`${lead} ${targetName(r.target)}, ${how}. Shall I take you there?${n > 1 && i === 0 ? ' Or say "next" to hear another.' : ''}`, { kind: 'offer', index: i });
  }

  function goTo(t: Target) {
    d.choose(t);
    const v = d.view();
    if (!v.route) {
      // Outside the walking area: the place card has already asked TfL.
      return ask(`${targetName(t)} is outside the walking area, so I'm finding public transport. Say "start" for the fastest option, or "taxi".`, { kind: 'startJourney' }, true);
    }
    ask(`${targetName(t)}: ${routeSummary(v.route)} ${startOrChoose(v.route.profile)}`, { kind: 'start' });
  }

  /** After a route type is picked: the new route's numbers, what it costs, and the other choices. */
  function routeChosen(p: RouteProfileId) {
    const r = d.view().route;
    if (!r) return ask(`${PROFILE_LABELS[p]} route. ${startOrChoose(p)}`, { kind: 'start' }, true);
    // tradeOff reads "Fewest crossings route: about the same time, 2 fewer crossings…": drop its own label.
    const trade = r.tradeOff ? ` Compared with the shortest: ${r.tradeOff.replace(/^[^:]*route:\s*/i, '')}` : '';
    return ask(`${PROFILE_LABELS[p]} route: ${routeSummary(r)}${trade} ${startOrChoose(p)}`, { kind: 'start' }, true);
  }

  function start() {
    pending = null;
    d.startWalk();
    speak(closingFor('nav'), true);
    d.rest();
  }

  // ---------------------------------------------------------------- answers during a walk (and any time)
  async function answer(intent: Intent) {
    const v = d.view();
    if (intent.name === 'help') {
      d.openHelp();
      return close('Help is open: you can call 999 or text your location. Nothing happens until you confirm.');
    }
    const r = await d.runIntent(intent);
    if (intent.name === 'navigateTo') return; // runIntent opened the place
    if (!r.say) return close('');
    // A place: offer to go there (instead, when walking).
    const data = r.data as Array<{ place?: Target & { id: string }; stop?: unknown }> | undefined;
    if (intent.name === 'nearest' && r.ok && Array.isArray(data) && data[0] && 'place' in data[0] && data[0].place) {
      const p = data[0].place as unknown as Target;
      const target: Target = { id: p.id, name: p.name, lat: p.lat, lng: p.lng, category: (p as { category: Target['category'] }).category, place: p as never };
      return ask(`${r.say} ${v.stage === 'nav' ? 'Do you want to go there instead?' : 'Shall I take you there?'}`, { kind: 'goInstead', target });
    }
    if (intent.name === 'aroundMe' && r.ok && Array.isArray(data) && data.length) {
      const items = (data as Array<{ place: Target }>).map((x) => x.place as unknown as Target).slice(0, 5);
      return ask(`${r.say} Would you like directions to one of them?`, { kind: 'pickNearby', items });
    }
    close(r.say);
  }

  // ---------------------------------------------------------------- the turn
  async function handle(raw: string) {
    const t = norm(raw);
    if (!t) return d.rest();
    d.caption('you', raw);
    const v = d.view();

    // Answers to a question Acuity asked.
    if (pending) {
      const p = pending;
      if (p.kind === 'offer') {
        const ord = ORDINALS.find(([re]) => re.test(t));
        if (ord && v.results[ord[1]]) return goTo(v.results[ord[1]].target);
        if (YES.test(t)) return goTo(v.results[p.index].target);
        if (NEXT.test(t) || NO.test(t)) return offer(p.index + 1);
      }
      if (p.kind === 'start' || p.kind === 'startJourney') {
        const prof = PROFILES.find(([re]) => re.test(t));
        if (prof) {
          d.setProfile(prof[1]);
          return routeChosen(prof[1]);
        }
        if (/\b(bus|train|tube|public transport|transport)\b/.test(t)) {
          d.showTransit();
          return ask("I'm finding buses and trains. Say \"start\" for the fastest.", { kind: 'startJourney' }, true);
        }
        if (/\btaxi|cab|uber\b/.test(t)) {
          d.openTaxi();
          return close('The taxi options are on screen: Uber, or copy the destination for any taxi. You book in the taxi app.');
        }
        if (YES.test(t)) return p.kind === 'start' ? start() : (d.startJourney(), close('Starting your journey.', true));
        if (NO.test(t)) return close('Okay.');
      }
      if (p.kind === 'goInstead') {
        if (YES.test(t)) {
          if (v.stage === 'nav') d.endWalk();
          return goTo(p.target);
        }
        if (NO.test(t)) return close('Okay, carrying on.');
      }
      if (p.kind === 'pickNearby') {
        const ord = ORDINALS.find(([re]) => re.test(t));
        const byName = p.items.find((it) => t.includes(norm(it.name)) || norm(it.name).split(' ').some((w) => w.length > 3 && t.includes(w)));
        const pick = (ord && p.items[ord[1]]) || byName || (YES.test(t) ? p.items[0] : null);
        if (pick) {
          if (v.stage === 'nav') d.endWalk();
          return goTo(pick);
        }
        if (NO.test(t)) return close('Okay.');
      }
      if (p.kind === 'watchLight') {
        if (YES.test(t)) {
          d.watchLight(true);
          return close("I'm watching the light and I'll tell you when it changes. Say 'stop watching' to stop.");
        }
        if (NO.test(t)) return close('Okay.');
      }
      if (p.kind === 'confirmStop') {
        if (YES.test(t)) {
          d.endWalk();
          return ask('Walk ended. Where would you like to go now?', { kind: 'destination' });
        }
        if (NO.test(t)) return close('Okay, carrying on.');
      }
      if (p.kind === 'destination' && !QUESTION_WORDS.test(t)) {
        const qm = quickMatch(raw);
        if (qm.name === 'unknown' || qm.name === 'nearest' || qm.name === 'navigateTo') return findDestination(qm.query ?? raw);
      }
      pending = null; // something else: handle it fresh below
    }

    // Requests that need no model.
    if (/\b(stop|cancel|end)\b.*\b(navigation|walk|walking|route|directions|journey)\b/.test(t)) {
      if (v.stage === 'nav' || v.stage === 'ride' || v.stage === 'rail') return ask('Do you want to stop this walk?', { kind: 'confirmStop' });
      return close('There is no walk to stop.');
    }
    if (/\b(how far|how long|how much (further|longer)|when (will|do) i (get|arrive)|arrival|how many (minutes|metres|meters)|eta)\b/.test(t))
      return close(d.tools.routeStatus({ route: v.route, remaining: v.remaining, next: v.nextInstruction }).say);
    if (/\b(bench|benches|sit down|somewhere to sit|rest)\b/.test(t))
      return close(d.tools.nearestBench({ route: v.stage === 'nav' ? v.route : null, progress: v.progress }, v.here).say);
    // The camera, by voice: no screen to manage, no button to press.
    if (/\bstop watching\b/.test(t)) {
      d.watchLight(false);
      return close('Stopped watching the light.');
    }
    if (LIGHT.test(t)) {
      speak('Checking the light. Point the phone across the road.');
      try {
        const r = await d.checkLight();
        return ask(`${r.sentence} Shall I keep watching and tell you when it changes?`, { kind: 'watchLight' }, true);
      } catch {
        return close('The light check needs the camera and the camera service on this laptop. Neither answered.', true);
      }
    }
    if (SCENE.test(t)) {
      speak('Let me look.');
      try {
        return close(await d.describeScene(raw), true);
      } catch {
        return close("I can't look right now: the camera or the camera service isn't available.", true);
      }
    }
    if (/\bopen (the )?camera\b/.test(t)) {
      d.openCamera(false);
      return close("I've opened the camera.");
    }
    const prof = PROFILES.find(([re]) => re.test(t));
    if (prof && (v.stage === 'place' || v.stage === 'nav') && v.sel) {
      d.setProfile(prof[1]);
      return v.stage === 'place' ? routeChosen(prof[1]) : close('');
    }
    if (v.stage === 'place' && YES.test(t)) return start();

    const qm = quickMatch(raw);
    if (qm.name === 'navigateTo' || (qm.name === 'nearest' && v.stage !== 'nav' && !/\b(nearest|closest|where'?s|where is)\b/.test(t))) return findDestination(qm.query ?? raw);
    if (qm.name !== 'unknown') return answer(qm);

    // A model picks the tool: Abdullah's gemma3 offline, Gemini online.
    let picked: Intent | null = null;
    try {
      const a = await agentIntent(raw);
      // The model may say "describe the scene" for "what's here": the camera only if they asked to look.
      if (a.intent === 'describeScene' && !SCENE.test(t)) a.intent = 'aroundMe';
      if (a.intent === 'describeScene') return handle('what can you see');
      if (a.intent === 'nearestBench' || a.intent === 'routeStatus' || a.intent === 'stopNavigation') return handle(`${a.intent === 'nearestBench' ? 'bench' : a.intent === 'routeStatus' ? 'how far' : 'stop navigation'}`);
      if (a.intent !== 'unknown') picked = { name: a.intent as Intent['name'], utterance: raw, query: a.query, side: a.side, confidence: 0.8, via: 'local-llm' };
    } catch {
      if (v.online) {
        const g = await geminiPickTool(raw);
        if (g.ok && g.intent.name !== 'unknown') picked = g.intent;
      }
    }
    if (picked) {
      if (picked.name === 'nearest' && v.stage !== 'nav' && picked.query && !/\b(nearest|closest|where)\b/.test(t)) return findDestination(picked.query);
      return answer(picked);
    }
    // Not a question we know: in explore, treat it as a place.
    if (v.stage === 'explore' || v.stage === 'results') return findDestination(raw);
    close("Sorry, I didn't get that. You can ask what's around you, how far it is, or for the nearest bench, toilet or park.");
  }

  return {
    /** First words: ask where to go and listen. */
    greet() {
      ask("Hi, I'm Acuity. Where would you like to go? Say a place, like Tesco, or a kind of place, like a pharmacy.", { kind: 'destination' });
    },
    /** A finished utterance from the ears. */
    handle: (text: string) => void handle(text),
    /** After "Hey Acuity" with nothing else: she answers and listens. */
    wake() {
      pending = null;
      speak('Yes?');
      d.listen();
    },
    reset() {
      pending = null;
    },
  };
}
