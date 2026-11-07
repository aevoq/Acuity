// The app shell, after the Claude Design redesign: a full-screen offline map
// with floating cards, one stage at a time:
//   explore → (answer) → results → place → nav → arrived,  and place → ride (bus).
// The engine underneath is unchanged: router + guidance (src/nav), simulated
// walk / GPS (src/sim, src/position), tools (src/places), TfL (src/transit),
// Gemini (src/net).
//
// Accessibility the shell guarantees:
//  - every prompt goes to a polite live region (re-announced even when the
//    text repeats), and is spoken aloud only when "Speak prompts" is on and
//    "I use a screen reader" is off, so it never talks over VoiceOver/NVDA;
//  - when the stage changes, focus moves to the new card's heading;
//  - Help and Settings are native modal dialogs (focus trap, Escape).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BusRoute, Intent, LatLng, Position, PositionSource, Route, RouteProfileId, SpeakRequest, ToolResult } from '../contracts';
import { distance } from '../geo/geo';
import { MapCanvas, mapBackground, type MapCanvasHandle, type MapPin } from '../mapview/MapCanvas';
import { PROFILE_LABELS } from '../nav/costs';
import { createGuidance, type Guidance, type GuidanceState } from '../nav/guidance';
import { createRouter } from '../nav/router';
import { connectivity } from '../net/connectivity';
import { geminiPickTool } from '../net/gemini';
import { useNetworkMode } from '../net/useConnectivity';
import { loadPack, type PackIndex } from '../pack/pack';
import { findPlaces } from '../places/search';
import { createTools } from '../places/tools';
import { createGpsSource, gpsAvailable } from '../position/gps';
import { createSimWalk, type SimWalk } from '../sim/simWalk';
import { busArrivals, routesAt } from '../transit/arrivals';
import { createBusRide, planBusRide, type BusRidePlan, type BusRideState } from '../transit/busRide';
import { boardSentence, isRoadVehicle, journeySentence, planJourneys, type Journey } from '../transit/journeys';
import { destinationText, uberLink } from '../transit/taxi';
import { RailStepCard, TaxiPanel, TransitPanel, type Travel } from './ui/Transit';
import { DEFAULT_PROFILE } from './defaultProfile';
import { quickMatch } from './quickMatch';
import { runIntent } from './runIntent';
import { useSettings } from './settings';
import { speakFallback } from './speakFallback';
import { AnswerCard, ArrivedCard, ExploreCard, PlaceCard, ResultsCard, type BusSetup } from './ui/Cards';
import { CategoryChips, RightControls, SearchBar, type CATEGORIES } from './ui/Controls';
import { HelpDialog, SettingsDialog } from './ui/Dialogs';
import { fmtDist, placeTarget, stopTarget, targetName, walkMinutes, type Answer, type ResultItem, type Target } from './ui/model';
import { NavBanner, RideCard, WalkCard } from './ui/Walk';
import './ui/ui.css';

/** Where the user "stands" before a walk: Marshgate, UCL East. */
const VENUE: Position = { lat: 51.537542, lng: -0.0119821, accuracy: 6, heading: null, speed: null, timestamp: 0, source: 'simulated' };
const BUS_SPEED = 6; // m/s for the simulated bus

type Mode = 'explore' | 'results' | 'place' | 'nav' | 'arrived' | 'ride' | 'rail';
const HEADING_FOR: Record<Mode, string> = { explore: 'here-h', results: 'res-h', place: 'place-h', nav: 'walk-h', arrived: 'arr-h', ride: 'ride-h', rail: 'rail-h' };
/** Intents that are questions (answer card), as opposed to place searches. */
const QUESTIONS = new Set(['aroundMe', 'leftRight', 'whereAmI', 'nextStep', 'repeat', 'help', 'nearestBusStop', 'busArrivals']);

export function App() {
  const net = useNetworkMode();
  const [settings, updateSettings] = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [index, setIndex] = useState<PackIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useMemo(() => (index ? createRouter(index) : null), [index]);
  const tools = useMemo(() => (index ? createTools({ index, router }) : null), [index, router]);
  const mapRef = useRef<MapCanvasHandle>(null);

  const [mode, setMode] = useState<Mode>('explore');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [chip, setChip] = useState<string | null>(null);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [resultsTitle, setResultsTitle] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [sel, setSel] = useState<Target | null>(null);
  const [profileId, setProfileId] = useState<RouteProfileId>(DEFAULT_PROFILE.routeProfile);
  const [route, setRoute] = useState<Route | null>(null);
  const [noRouteText, setNoRouteText] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [me, setMe] = useState<Position>(VENUE);
  const [follow, setFollow] = useState(true);
  const [gstate, setGstate] = useState<GuidanceState | null>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  // bus
  const [arrivals, setArrivals] = useState<string | null>(null);
  const [loadingArrivals, setLoadingArrivals] = useState(false);
  const [rideRouteId, setRideRouteId] = useState<string | null>(null);
  const [alightId, setAlightId] = useState<string | null>(null);
  const [ride, setRide] = useState<BusRideState | null>(null);
  const [ridePlan, setRidePlan] = useState<BusRidePlan | null>(null);
  // public transport + taxi
  const [travel, setTravel] = useState<Travel>('walk');
  const [transit, setTransit] = useState<{ key: string; state: 'loading' | 'ok' | 'error'; journeys: Journey[]; message: string | null } | null>(null);
  const [journeyIdx, setJourneyIdx] = useState(0);
  const [trip, setTrip] = useState<{ journey: Journey; leg: number } | null>(null);
  const tripRef = useRef(trip);
  tripRef.current = trip;
  const [copied, setCopied] = useState(false);

  const sourceRef = useRef<PositionSource | null>(null);
  const guidanceRef = useRef<Guidance | null>(null);
  const rideRef = useRef<ReturnType<typeof createBusRide> | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const lastSaid = useRef<string | null>(null);
  const meRef = useRef(me);
  meRef.current = me;

  // ---------------------------------------------------------------- output
  /** Every prompt: live region (always) + voice (when wanted). Stable, so guidance can hold it. */
  const speak = useCallback((req: SpeakRequest | string) => {
    const r = typeof req === 'string' ? { text: req } : req;
    if (!r.text) return;
    lastSaid.current = r.text;
    // Clear first, so the same words twice in a row are announced twice.
    setAnnounce('');
    requestAnimationFrame(() => setAnnounce(r.text));
    const s = settingsRef.current;
    speakFallback(r, { ...DEFAULT_PROFILE, speechRate: s.speechRate, usesScreenReader: s.screenReader || !s.voice });
  }, []);

  useEffect(() => {
    loadPack()
      .then((ix) => {
        setIndex(ix);
        setAnnounce(`Area map loaded: ${ix.pack.name}. ${ix.pack.places.length} places. Map saved ${ix.ageDays() === 0 ? 'today' : `${ix.ageDays()} days ago`}.`);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (index) requestAnimationFrame(() => mapRef.current?.flyTo(meRef.current, 0.8, 900));
  }, [index]);

  useEffect(
    () => connectivity.subscribe((m) => speak(m === 'offline' ? 'You are offline. Navigation and questions still work.' : 'Back online. Live features are available.')),
    [speak],
  );

  // Move focus to the new card's heading when the stage changes (not on first load).
  const firstFocus = useRef(true);
  useEffect(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
      return;
    }
    const id = answer ? 'ans-h' : HEADING_FOR[mode];
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }, [mode, answer, resultsTitle]);

  // Real GPS while not walking, when the setting is on.
  useEffect(() => {
    if (!settings.realGps || mode === 'nav' || mode === 'ride') return;
    const gps = createGpsSource();
    const off = gps.subscribe(setMe);
    gps.start();
    return () => {
      off();
      gps.stop();
    };
  }, [settings.realGps, mode]);

  // ---------------------------------------------------------------- walking + riding lifecycle
  const stopMoving = () => {
    guidanceRef.current?.stop();
    rideRef.current?.stop();
    sourceRef.current?.stop();
    unsubRef.current?.();
    guidanceRef.current = rideRef.current = sourceRef.current = unsubRef.current = null;
    setGstate(null);
    setRide(null);
    setRidePlan(null);
    setPaused(false);
  };
  useEffect(() => () => stopMoving(), []);
  const sim = () => (sourceRef.current?.kind === 'simulated' ? (sourceRef.current as SimWalk) : null);

  // A walk (or a ride) ended: on a public transport journey, go on to the next leg.
  useEffect(() => {
    if (!gstate?.arrived) return;
    const t = tripRef.current;
    if (t && t.leg < t.journey.legs.length - 1) nextLegRef.current();
    else setMode('arrived');
  }, [gstate?.arrived]);
  useEffect(() => {
    if (!ride?.arrived || !tripRef.current) return;
    const id = setTimeout(() => nextLegRef.current(), 1500);
    return () => clearTimeout(id);
  }, [ride?.arrived]);
  const nextLegRef = useRef<() => void>(() => {});

  // ---------------------------------------------------------------- routes
  const plan = (t: Target, prof: RouteProfileId, from: Position = meRef.current): Route | null => {
    if (!router) return null;
    const r = router.route(from, t, prof, targetName(t));
    setRoute(r);
    setNoRouteText(r ? null : `No ${PROFILE_LABELS[prof].toLowerCase()} route to ${targetName(t)} in the downloaded area.`);
    return r;
  };

  const routeSentence = (r: Route) =>
    `${r.destinationName}. ${walkMinutes(r.lengthMeters)} minute walk, ${Math.round(r.lengthMeters / 10) * 10} metres, ${r.crossings} crossing${r.crossings === 1 ? '' : 's'}.${r.tradeOff ? ` ${r.tradeOff}` : ''}`;

  const choose = (t: Target) => {
    stopMoving();
    setSel(t);
    setAnswer(null);
    setShowSteps(false);
    setArrivals(null);
    setRideRouteId(null);
    setAlightId(null);
    setTravel('walk');
    setTransit(null);
    setTrip(null);
    setCopied(false);
    setFollow(false);
    setMode('place');
    const r = plan(t, profileId);
    if (r) {
      mapRef.current?.fitPoints(r.path, 30);
      speak(routeSentence(r));
    } else {
      mapRef.current?.flyTo(t, 0.6);
      speak(`No ${PROFILE_LABELS[profileId].toLowerCase()} route to ${targetName(t)} in the downloaded area.`);
    }
  };

  const changeProfile = (p: RouteProfileId) => {
    setProfileId(p);
    if (!sel) return;
    // Step-free changes the public transport options too.
    if (travel === 'transit' && (p === 'stepFree') !== (profileId === 'stepFree')) void fetchTransit(p === 'stepFree');
    const r = plan(sel, p);
    if (r) {
      mapRef.current?.fitPoints(r.path, 30);
      speak(r.tradeOff ?? `${PROFILE_LABELS[p]} route: ${walkMinutes(r.lengthMeters)} minutes, ${r.crossings} crossings.`);
    }
  };

  // ---------------------------------------------------------------- search
  const walkTo = (t: Target) => router?.walkingDistance(meRef.current, t) ?? distance(meRef.current, t) * 1.3;

  /** Show results for a place query. Returns how many were found. */
  const search = (q: string, label?: string, quietIfEmpty = false): number => {
    if (!index) return 0;
    let items: ResultItem[];
    if (/^bus ?stops?$/i.test(q.trim())) {
      items = index
        .busStopsNear(meRef.current, 800, 12)
        .map(({ stop }) => ({ target: stopTarget(stop), walk: 0 }))
        .map((it) => ({ ...it, walk: walkTo(it.target) }))
        .sort((a, b) => a.walk - b.walk)
        .slice(0, 8);
    } else {
      items = findPlaces(index, router, meRef.current, q, 8, 8).map((h) => ({ target: placeTarget(h.place), walk: h.walkMeters ?? h.straightMeters * 1.3 }));
    }
    if (!items.length && quietIfEmpty) return 0;
    stopMoving();
    setResults(items);
    setResultsTitle(items.length ? `${label ?? `“${q}”`} nearby` : 'No results');
    setAnswer(null);
    setSel(null);
    setRoute(null);
    setFollow(false);
    setMode('results');
    if (!items.length) speak(`I couldn't find "${q}" in the downloaded area.`);
    else {
      const h = items[0];
      speak(`${items.length} result${items.length === 1 ? '' : 's'}. Nearest: ${targetName(h.target)}, about ${Math.round(h.walk / 10) * 10} metres walk.`);
      mapRef.current?.fitPoints([meRef.current, ...items.slice(0, 5).map((i) => i.target)]);
    }
    return items.length;
  };

  const pickChip = (c: (typeof CATEGORIES)[number]) => {
    setChip(c.label);
    setQuery(c.label);
    search(c.query, c.label);
  };

  // ---------------------------------------------------------------- questions
  const navigateTo = (q: string): ToolResult => {
    if (!index) return { ok: false, intent: 'navigateTo', say: 'The map is still loading.' };
    const hits = findPlaces(index, router, meRef.current, q, 1);
    if (!hits.length) return { ok: false, intent: 'navigateTo', say: `I couldn't find ${q} in the downloaded area.` };
    choose(placeTarget(hits[0].place));
    return { ok: true, intent: 'navigateTo', say: '' };
  };

  const answerFrom = (intent: Intent, res: ToolResult, asked: string): Answer => {
    const items: Answer['items'] = [];
    const data = res.data as unknown;
    if (Array.isArray(data)) {
      for (const d of data as Array<Record<string, unknown>>) {
        if (d.place) items.push({ target: placeTarget(d.place as never), meters: Number(d.walkMeters ?? d.meters ?? d.straightMeters ?? 0) });
        else if (d.stop) items.push({ target: stopTarget(d.stop as never), meters: Number(d.meters ?? 0) });
      }
    } else if (data && typeof data === 'object' && (data as { landmark?: unknown }).landmark) {
      const lm = (data as { landmark: never }).landmark;
      items.push({ target: placeTarget(lm), meters: distance(meRef.current, lm) });
    }
    const icon: Record<string, string> = {
      whereAmI: 'person_pin_circle', aroundMe: 'explore', leftRight: 'explore', nearestBusStop: 'directions_bus', busArrivals: 'schedule',
      nearest: 'place', nextStep: 'record_voice_over', repeat: 'replay', unknown: 'warning',
    };
    const goTo = intent.name === 'nearestBusStop' || intent.name === 'nearest' ? items[0]?.target : undefined;
    return { q: asked, icon: icon[intent.name] ?? 'explore', text: res.say, items: items.slice(0, 5), goTo };
  };

  const ask = async (intent: Intent, asked: string) => {
    if (!index || !tools) return;
    const res = await runIntent(intent, {
      index,
      tools,
      here: sourceRef.current?.current() ?? meRef.current,
      guidance: guidanceRef.current,
      lastSaid: lastSaid.current,
      navigateTo,
      openHelp: () => setHelpOpen(true),
    });
    if (intent.name === 'navigateTo' || intent.name === 'help') {
      if (res.say) speak(res.say);
      return;
    }
    const a = answerFrom(intent, res, asked);
    stopMoving();
    setAnswer(a);
    setMode('explore');
    setResults([]);
    speak({ text: res.say, milestone: res.milestone });
    if (a.items.length) mapRef.current?.fitPoints([meRef.current, ...a.items.map((i) => i.target)]);
  };

  const onAskButton = (kind: 'where' | 'around' | 'bus' | 'toilets') => {
    const base = { confidence: 1, via: 'keywords' as const };
    if (kind === 'toilets') return void search('toilets', 'Toilets');
    if (kind === 'where') return void ask({ ...base, name: 'whereAmI', utterance: 'Where am I?' }, 'Where am I?');
    if (kind === 'around') return void ask({ ...base, name: 'aroundMe', utterance: "What's around me?" }, "What's around me?");
    return void ask({ ...base, name: 'nearestBusStop', utterance: 'Nearest bus stop' }, 'Nearest bus stop');
  };

  /** The search box takes places ("tesco") and questions ("what's on my left"). */
  const submit = async () => {
    const text = query.trim();
    if (!text || !index) return;
    setChip(null);
    const qm = quickMatch(text);
    if (QUESTIONS.has(qm.name)) return void ask(qm, text);
    if (qm.name === 'navigateTo' && qm.query) {
      const r = navigateTo(qm.query);
      if (!r.ok) speak(r.say);
      return;
    }
    if (qm.name === 'nearest' && qm.query) return void search(qm.query);
    // Plain words: a place search first (free, offline); Gemini only if that finds nothing.
    if (search(text, undefined, true)) return;
    if (net === 'online') {
      setBusy(true);
      const g = await geminiPickTool(text);
      setBusy(false);
      if (g.ok) {
        if (QUESTIONS.has(g.intent.name)) return void ask(g.intent, text);
        if ((g.intent.name === 'nearest' || g.intent.name === 'navigateTo') && g.intent.query) return void search(g.intent.query);
      }
    }
    search(text);
  };

  const clearSearch = () => {
    stopMoving();
    setQuery('');
    setChip(null);
    setResults([]);
    setAnswer(null);
    setSel(null);
    setRoute(null);
    setMode('explore');
    setFollow(true);
    mapRef.current?.flyTo(meRef.current, 0.8);
  };

  // ---------------------------------------------------------------- walk controls
  const startWalk = (r: Route | null = route) => {
    if (!r || !sel) return;
    stopMoving();
    const src: PositionSource = settings.realGps ? createGpsSource() : createSimWalk(r.path, { speedFactor: speed });
    const g = createGuidance({ route: r, source: src, onSpeak: speak, onState: setGstate, reassuranceEveryMeters: DEFAULT_PROFILE.reassuranceEveryMeters });
    unsubRef.current = src.subscribe(setMe);
    sourceRef.current = src;
    guidanceRef.current = g;
    setMode('nav');
    setShowSteps(false);
    setFollow(true);
    mapRef.current?.flyTo(meRef.current, 0.42, 900);
    g.start();
    src.start();
  };

  const endWalk = () => {
    stopMoving();
    setTrip(null);
    setMode('place');
    setFollow(false);
    if (sel) {
      const r = plan(sel, profileId);
      if (r) mapRef.current?.fitPoints(r.path, 30);
    }
    speak('Navigation ended.');
  };

  const finish = () => {
    stopMoving();
    setSel(null);
    setRoute(null);
    setResults([]);
    setQuery('');
    setChip(null);
    setMode('explore');
    setFollow(true);
    mapRef.current?.flyTo(meRef.current, 0.8);
  };

  const reroute = () => {
    if (!sel) return;
    const from = sourceRef.current?.current() ?? meRef.current;
    const r = plan(sel, profileId, from);
    if (r) {
      speak({ text: 'New route from here.', priority: 'interrupt' });
      startWalk(r);
    }
  };

  const pauseResume = () => {
    const s = sim();
    if (!s) return;
    if (s.isRunning()) s.pause();
    else s.resume();
    setPaused(!s.isRunning());
  };
  const changeSpeed = (f: number) => {
    setSpeed(f);
    sim()?.setSpeedFactor(f);
  };

  // ---------------------------------------------------------------- bus
  const stop = sel?.stop ?? null;
  const stopRoutes: BusRoute[] = useMemo(() => (index && stop ? routesAt(index, stop) : []), [index, stop]);
  const rideRoute = stopRoutes.find((r) => r.id === rideRouteId) ?? null;
  const ahead = useMemo(() => {
    if (!index || !stop || !rideRoute) return [];
    const byId = new Map(index.pack.busStops.map((s) => [s.id, s]));
    const i = rideRoute.stops.indexOf(stop.id);
    return rideRoute.stops.slice(i + 1, i + 16).map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
  }, [index, stop, rideRoute]);

  const nextBuses = async () => {
    if (!index || !stop) return;
    setLoadingArrivals(true);
    const r = await busArrivals(index, stop);
    setLoadingArrivals(false);
    setArrivals(r.say);
    speak(r.say);
  };

  const startRide = () => {
    if (!index || !stop || !rideRoute || !alightId) return;
    const p = planBusRide(index, rideRoute, stop.id, alightId);
    if (!p) return speak('That bus does not go to that stop from here.');
    rideWith(p);
  };

  /** Count down the stops of a ride, following a simulated bus (or real GPS). */
  const rideWith = (p: BusRidePlan, metresPerSecond = BUS_SPEED) => {
    stopMoving();
    const src: PositionSource = settings.realGps ? createGpsSource() : createSimWalk(p.line, { speed: metresPerSecond, speedFactor: speed, jitterMeters: 4 });
    unsubRef.current = src.subscribe(setMe);
    const r = createBusRide({ plan: p, source: src, onSpeak: speak, onState: setRide });
    sourceRef.current = src;
    rideRef.current = r;
    setRidePlan(p);
    setMode('ride');
    setFollow(true);
    mapRef.current?.fitPoints(p.line, 60);
    r.start();
    src.start();
  };

  const endRide = () => {
    stopMoving();
    setTrip(null);
    setMode('place');
    setFollow(false);
  };

  // ---------------------------------------------------------------- public transport (TfL, online)
  const transitKey = sel ? `${sel.id}|${profileId === 'stepFree'}` : '';

  const fetchTransit = async (stepFree = profileId === 'stepFree') => {
    if (!index || !sel) return;
    const key = `${sel.id}|${stepFree}`;
    setTransit({ key, state: 'loading', journeys: [], message: null });
    setJourneyIdx(0);
    const r = await planJourneys(index, meRef.current, sel, { stepFree });
    if (!r.ok) {
      setTransit({ key, state: 'error', journeys: [], message: r.message });
      speak(r.message);
      return;
    }
    setTransit({ key, state: 'ok', journeys: r.journeys, message: null });
    speak(`${r.journeys.length} option${r.journeys.length === 1 ? '' : 's'}. Fastest: ${journeySentence(r.journeys[0])}`);
    mapRef.current?.fitPoints(r.journeys[0].legs.flatMap((l) => l.path), 30);
  };

  const onTravel = (t: Travel) => {
    setTravel(t);
    if (t === 'transit' && (!transit || transit.key !== transitKey)) void fetchTransit();
    if (t === 'transit' && transit?.state === 'ok') speak(journeySentence(transit.journeys[journeyIdx]));
    if (t === 'taxi') speak(net === 'offline' ? 'Taxi apps need a connection.' : `Taxi: open Uber with the trip to ${sel ? targetName(sel) : 'here'} filled in, or copy the destination. You book in the taxi app.`);
    if (t === 'walk' && route) speak(routeSentence(route));
  };

  const journey = transit?.state === 'ok' ? (transit.journeys[journeyIdx] ?? null) : null;

  /** A walking Route along TfL's own path, when our router can't (outside the downloaded area). */
  const pathRoute = (path: LatLng[], name: string): Route => {
    const len = path.reduce((acc, p, i) => (i ? acc + distance(path[i - 1], p) : 0), 0);
    const wp = (kind: 'start' | 'arrive', at: LatLng, along: number, instruction: string) => ({
      id: kind, kind, lat: at.lat, lng: at.lng, triggerRadius: kind === 'arrive' ? 15 : 0, instruction, distanceAlong: along,
      milestone: kind === 'arrive' ? ('arrived' as const) : null, icon: kind === 'arrive' ? 'flag' : 'directions_walk',
      title: kind === 'arrive' ? `Arrive at ${name}` : `Walk to ${name}`, detail: kind === 'arrive' ? '' : 'Route from TfL',
    });
    return {
      profile: 'shortest', from: path[0], to: path[path.length - 1], destinationName: name, path, edgeIds: [],
      lengthMeters: Math.round(len), durationSeconds: Math.round(len / 1.4), crossings: 0, signalledCrossings: 0, tradeOff: null,
      waypoints: [wp('start', path[0], 0, `Walk to ${name}, ${Math.round(len / 10) * 10} metres.`), wp('arrive', path[path.length - 1], Math.round(len), `You have arrived at ${name}.`)],
    };
  };

  const startLeg = (j: Journey, i: number, from: LatLng = meRef.current) => {
    const leg = j.legs[i];
    setTrip({ journey: j, leg: i });
    if (!leg) {
      stopMoving();
      setMode('arrived');
      return;
    }
    if (leg.mode === 'walking') {
      const last = i === j.legs.length - 1;
      const name = last && sel ? targetName(sel) : [leg.to.name, leg.to.indicator].filter(Boolean).join(', ');
      const r = router?.route({ ...from }, leg.to, profileId, name) ?? (leg.path.length > 1 ? pathRoute(leg.path, name) : null);
      if (!r) return speak(`I can't find a walking route to ${name}.`);
      setRoute(r);
      startWalk(r);
      return;
    }
    speak(boardSentence(leg));
    const stops = [{ name: leg.from.name, at: { lat: leg.from.lat, lng: leg.from.lng }, id: leg.from.naptanId }, ...leg.stops].filter((st) => st.at);
    if (isRoadVehicle(leg.mode) && stops.length >= 2) {
      // Bus or tram: count the stops down by GPS (positions from the pack, the last from TfL).
      const plan: BusRidePlan = {
        route: { id: `${leg.line}-trip`, name: leg.line ?? 'bus', direction: '', stops: [], frequencyMinutes: null, destination: leg.towards ?? undefined },
        stops: stops.map((st, k) => ({ id: st.id ?? `trip-${k}`, name: st.name, naptanId: st.id, lat: st.at!.lat, lng: st.at!.lng, indicator: k === 0 ? leg.from.indicator : null })),
        line: stops.map((st) => st.at!),
      };
      rideWith(plan);
      return;
    }
    // Tube, DLR, Overground, rail: no GPS underground, so the person says when they are off.
    stopMoving();
    setRidePlan(null);
    setFollow(false);
    setMode('rail');
    mapRef.current?.fitPoints(leg.path.length ? leg.path : [leg.from, leg.to], 40);
    speak('There is no GPS underground. Count the stops or listen for the announcements, and press "I\'m off" when you are.');
  };

  nextLegRef.current = () => {
    const t = tripRef.current;
    if (!t) return;
    const leg = t.journey.legs[t.leg];
    startLeg(t.journey, t.leg + 1, leg ? leg.to : meRef.current);
  };

  const startJourney = () => {
    if (!journey) return;
    speak(`Starting: ${journeySentence(journey)}`);
    startLeg(journey, 0);
  };

  const railArrived = () => {
    const t = tripRef.current;
    if (!t) return;
    const leg = t.journey.legs[t.leg];
    // Back above ground at the station: start from there.
    setMe({ ...meRef.current, lat: leg.to.lat, lng: leg.to.lng, heading: null });
    speak(`At ${leg.to.name}.`);
    nextLegRef.current();
  };

  const copyDestination = async () => {
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(destinationText(targetName(sel), sel));
      setCopied(true);
      speak('Destination copied. Paste it into any taxi app, or read it to the driver.');
    } catch {
      speak(`Could not copy. The destination is ${targetName(sel)}.`);
    }
  };

  const busSetup: BusSetup | null = stop
    ? {
        arrivals,
        loadingArrivals,
        onNextBuses: nextBuses,
        routes: stopRoutes,
        routeId: rideRouteId,
        onRoute: (id) => {
          setRideRouteId(id);
          setAlightId(null);
        },
        ahead,
        alightId,
        onAlight: setAlightId,
        onStartRide: startRide,
      }
    : null;

  // ---------------------------------------------------------------- derived view values
  const uiZoom = settings.textSize;
  const walking = mode === 'nav';
  const progress = gstate?.progressMeters ?? 0;
  const remaining = route ? Math.max(0, route.lengthMeters - progress) : 0;
  const nextWp = walking && route ? (gstate?.next ?? route.waypoints.find((w) => w.kind !== 'start') ?? null) : null;
  const thenWp = nextWp && route ? (route.waypoints[route.waypoints.indexOf(nextWp) + 1] ?? null) : null;

  const street = index?.streetAt(me, 80)?.name ?? null;
  const atVenue = distance(me, VENUE) < 40;
  const age = index ? (index.ageDays() === 0 ? 'Map saved today' : `Map saved ${index.ageDays()} days ago`) : '';
  const hereName = atVenue ? 'Marshgate, UCL East' : (street ?? 'Your position');
  const hereSub = [atVenue && street ? `Near ${street}` : null, age].filter(Boolean).join(' · ');
  const where = `${street ? `${street}, ` : ''}${me.lat.toFixed(5)}, ${me.lng.toFixed(5)}`;
  const smsHref = `sms:?&body=${encodeURIComponent(`I need help. My location: ${where} https://maps.google.com/?q=${me.lat.toFixed(5)},${me.lng.toFixed(5)}`)}`;

  const pins: MapPin[] =
    mode === 'results'
      ? results.map((r, i) => ({ at: r.target, n: i + 1, label: `${i + 1}. ${targetName(r.target)}, ${fmtDist(r.walk)}`, onClick: () => choose(r.target) }))
      : [];
  const showRoute = !!route && ((mode === 'place' && travel === 'walk') || mode === 'nav' || mode === 'arrived');
  const dest = sel && (mode === 'place' || mode === 'nav' || mode === 'arrived') ? sel : null;

  let banner = null;
  if (walking && gstate?.offRoute) {
    banner = <NavBanner warn icon="wrong_location" dist="" title="Off route" sub={`About ${Math.round(gstate.offsetMeters / 10) * 10} metres from the route. Press Reroute.`} />;
  } else if (walking && gstate?.poorGps) {
    banner = <NavBanner warn icon="gps_not_fixed" dist="" title="Poor GPS" sub="Waiting for a better signal before the next instruction." />;
  } else if (walking && nextWp) {
    banner = (
      <NavBanner
        icon={nextWp.icon ?? 'straight'}
        dist={fmtDist(Math.max(0, nextWp.distanceAlong - progress))}
        title={nextWp.title ?? nextWp.instruction}
        sub={nextWp.detail}
        then={thenWp && thenWp.kind !== 'start' ? { icon: thenWp.icon ?? 'straight', title: thenWp.title ?? '' } : null}
      />
    );
  } else if (mode === 'rail' && trip) {
    const leg = trip.journey.legs[trip.leg];
    banner = (
      <NavBanner
        icon={leg.mode === 'tube' ? 'subway' : 'train'}
        dist={`${leg.stops.length} stops`}
        title={`${leg.line ?? ''}${leg.mode === 'tube' ? ' line' : ''}${leg.towards ? ` towards ${leg.towards}` : ''}`}
        sub={`Get off at ${leg.to.name}`}
      />
    );
  } else if (mode === 'ride' && ride && ridePlan) {
    const alight = ridePlan.stops[ridePlan.stops.length - 1];
    banner = ride.arrived ? (
      <NavBanner icon="flag" dist="" title="This is your stop" sub={alight.name} />
    ) : (
      <NavBanner
        icon={ride.stopsLeft === 1 ? 'notifications_active' : 'directions_bus'}
        dist={`${ride.stopsLeft} stop${ride.stopsLeft === 1 ? '' : 's'}`}
        title={ride.stopsLeft === 1 ? 'Your stop is next. Ring the bell.' : `Next: ${ride.nextStop?.name ?? ''}`}
        sub={`Get off at ${alight.name}`}
      />
    );
  }

  const arrive = new Date(Date.now() + (remaining / 1.4) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <main className={`shell${settings.mapStyle === 'highContrast' ? ' hc' : ''}`} style={{ background: mapBackground(settings.mapStyle), ['--ui-zoom' as string]: uiZoom }}>
      {index && (
        <MapCanvas
          ref={mapRef}
          index={index}
          palette={settings.mapStyle}
          me={me}
          meStyle={walking || mode === 'ride' ? 'arrow' : 'dot'}
          route={showRoute ? route : null}
          progress={walking ? progress : null}
          pins={pins}
          dest={dest}
          line={
            mode === 'ride' && ridePlan
              ? ridePlan.line
              : mode === 'place' && travel === 'transit' && journey
                ? journey.legs.flatMap((l) => l.path)
                : mode === 'rail' && trip
                  ? (trip.journey.legs[trip.leg]?.path ?? null)
                  : null
          }
          lineStops={
            mode === 'ride' && ridePlan
              ? ridePlan.line
              : mode === 'place' && travel === 'transit' && journey
                ? journey.legs.filter((l) => l.mode !== 'walking').flatMap((l) => [l.from, l.to])
                : mode === 'rail' && trip
                  ? [trip.journey.legs[trip.leg].from, trip.journey.legs[trip.leg].to]
                  : null
          }
          follow={follow}
          onUserMove={() => setFollow(false)}
          uiZoom={uiZoom}
          navMode={walking || mode === 'ride'}
          label={`Map of ${index.pack.name}${showRoute && sel ? `, route to ${targetName(sel)}` : ''}`}
        />
      )}

      <div className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </div>

      <div className="right-col" style={{ zoom: uiZoom }}>
        <RightControls
          offline={net === 'offline'}
          onToggleOffline={() => connectivity.forceOffline(net !== 'offline')}
          onZoomIn={() => mapRef.current?.zoomBy(1 / 1.6)}
          onZoomOut={() => mapRef.current?.zoomBy(1.6)}
          following={follow}
          onRecenter={() => {
            setFollow(true);
            mapRef.current?.flyTo(me, walking ? 0.42 : 0.8);
          }}
          onSettings={() => setSettingsOpen(true)}
          onHelp={() => setHelpOpen(true)}
        />
      </div>

      <div className="left-col" style={{ zoom: uiZoom }}>
        {mode !== 'nav' && mode !== 'ride' && mode !== 'rail' && mode !== 'arrived' ? (
          <div className="top-stack">
            <SearchBar query={query} onQuery={setQuery} onSubmit={submit} onClear={clearSearch} busy={busy} />
            <CategoryChips active={mode === 'results' ? chip : null} onPick={pickChip} />
          </div>
        ) : (
          <div className="top-stack">{banner}</div>
        )}

        <div className="bottom-stack">
          {!index && <div className="card">{error ? `Could not load the area map: ${error}` : 'Loading the area map…'}</div>}

          {index && mode === 'explore' && !answer && <ExploreCard hereName={hereName} hereSub={hereSub} onAsk={onAskButton} />}

          {index && mode === 'explore' && answer && (
            <AnswerCard answer={answer} me={me} onClose={() => setAnswer(null)} onSayAgain={() => speak(answer.text)} onChoose={choose} />
          )}

          {mode === 'results' && <ResultsCard title={resultsTitle} results={results} me={me} onClose={clearSearch} onChoose={choose} />}

          {mode === 'place' && sel && (
            <PlaceCard
              target={sel}
              route={route}
              noRouteText={noRouteText}
              profile={profileId}
              onProfile={changeProfile}
              onStart={() => startWalk()}
              showSteps={showSteps}
              onToggleSteps={() => setShowSteps((v) => !v)}
              onBack={() => {
                if (results.length) {
                  setMode('results');
                  setSel(null);
                  setRoute(null);
                  mapRef.current?.fitPoints([me, ...results.slice(0, 5).map((r) => r.target)]);
                } else finish();
              }}
              bus={busSetup}
              travel={travel}
              onTravel={onTravel}
              travelPanel={
                travel === 'transit' ? (
                  <TransitPanel
                    state={transit?.state ?? 'loading'}
                    journeys={transit?.journeys ?? []}
                    message={transit?.message ?? null}
                    selected={journeyIdx}
                    onSelect={(i) => {
                      setJourneyIdx(i);
                      const jj = transit?.journeys[i];
                      if (jj) {
                        speak(journeySentence(jj));
                        mapRef.current?.fitPoints(jj.legs.flatMap((l) => l.path), 30);
                      }
                    }}
                    onStart={startJourney}
                    stepFree={profileId === 'stepFree'}
                  />
                ) : travel === 'taxi' ? (
                  <TaxiPanel
                    offline={net === 'offline'}
                    uberHref={uberLink(me, sel, targetName(sel))}
                    destination={destinationText(targetName(sel), sel)}
                    copied={copied}
                    onCopy={copyDestination}
                  />
                ) : null
              }
            />
          )}

          {walking && (
            <WalkCard
              minutes={`${walkMinutes(remaining)} min`}
              meta={`${fmtDist(remaining)} · arrive ${arrive}${trip ? ` · step ${trip.leg + 1} of ${trip.journey.legs.length}` : ''}`}
              simulated={sourceRef.current?.kind === 'simulated'}
              paused={paused}
              offRoute={!!gstate?.offRoute}
              poorGps={!!gstate?.poorGps}
              speed={speed}
              onSpeed={changeSpeed}
              onEnd={endWalk}
              onRepeat={() => speak(guidanceRef.current?.lastPrompt() ?? lastSaid.current ?? 'Nothing to repeat yet.')}
              onWhatNext={() => speak(guidanceRef.current?.nextStep() ?? 'Choose a destination first.')}
              onPause={pauseResume}
              onReroute={reroute}
              onStepOff={() => sim()?.setSidestep(gstate?.offRoute ? 0 : 40)}
              onPoorGps={() => sim()?.setAccuracy(gstate?.poorGps ? null : 45)}
            />
          )}

          {mode === 'ride' && ridePlan && (
            <RideCard
              title={ride?.arrived ? 'At your stop' : `${ride?.stopsLeft ?? ridePlan.stops.length - 1} stops to go`}
              meta={`Bus ${ridePlan.route.name}${ridePlan.route.destination ? ` to ${ridePlan.route.destination}` : ''}${trip ? ` · step ${trip.leg + 1} of ${trip.journey.legs.length}` : ''}`}
              speed={speed}
              onSpeed={changeSpeed}
              onEnd={endRide}
              onRepeat={() => speak(lastSaid.current ?? 'Nothing to repeat yet.')}
            />
          )}

          {mode === 'rail' && trip && (
            <RailStepCard
              leg={trip.journey.legs[trip.leg]}
              legNo={trip.leg + 1}
              legs={trip.journey.legs.length}
              onArrived={railArrived}
              onEnd={endRide}
              onRepeat={() => speak(lastSaid.current ?? 'Nothing to repeat yet.')}
            />
          )}

          {mode === 'arrived' && sel && <ArrivedCard name={targetName(sel)} onDone={finish} />}
        </div>
      </div>

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} where={where} smsHref={smsHref} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onChange={updateSettings} gpsAvailable={gpsAvailable()} />
    </main>
  );
}
