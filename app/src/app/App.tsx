// The page shell. Owns layout, the online/offline switch, the live region,
// the map, and wires the offline core together:
//   search a place → route it with the chosen profile → walk it (simulated
//   or real GPS) → guidance speaks each waypoint.
// Feature folders (voice, agent, vision) plug in here.
//
// Accessibility basics this shell guarantees:
//  - one <h1>, landmarks (header / main), a skip link;
//  - every prompt is mirrored into a polite live region, so screen reader
//    users hear it in their own voice (principle 6);
//  - controls are real buttons and radios, 48 px or larger, keyboard reachable.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Intent, LatLng, Milestone, Place, Position, PositionSource, Route, RouteProfileId, SpeakRequest, ToolResult } from '../contracts';
import { createTools } from '../places/tools';
import { AskPanel } from './AskPanel';
import { BusPanel } from './BusPanel';
import { HelpPanel } from './HelpPanel';
import { runIntent } from './runIntent';
import { MapView } from '../mapview/MapView';
import { PROFILE_LABELS } from '../nav/costs';
import { createGuidance, type Guidance, type GuidanceState } from '../nav/guidance';
import { createRouter } from '../nav/router';
import { connectivity } from '../net/connectivity';
import { useNetworkMode } from '../net/useConnectivity';
import { loadPack, type PackIndex } from '../pack/pack';
import { findPlaces, type PlaceHit } from '../places/search';
import { createGpsSource, gpsAvailable } from '../position/gps';
import { createSimWalk, type SimWalk } from '../sim/simWalk';
import { DEFAULT_PROFILE } from './defaultProfile';
import { speakFallback } from './speakFallback';
import './app.css';

/** Where the user "stands" before a walk: Marshgate, UCL East. */
const VENUE: Position = { lat: 51.537542, lng: -0.0119821, accuracy: 5, heading: null, speed: null, timestamp: 0, source: 'simulated' };

const MILESTONE_LABEL: Record<Milestone, string> = {
  turnAhead: 'Turn',
  crossingAhead: 'Crossing',
  crossingAccessible: 'Crossing (signals or tactile)',
  benchNearby: 'Bench',
  busStopPassed: 'Stop passed',
  yourStopNext: 'Your stop next',
  offRoute: 'Off route',
  arrived: 'Arrived',
};

const PROFILES = Object.keys(PROFILE_LABELS) as RouteProfileId[];
const SPEEDS = [1, 4, 10];

interface Prompt {
  id: number;
  text: string;
  milestone?: Milestone;
}

export function App() {
  const mode = useNetworkMode();
  const [index, setIndex] = useState<PackIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const router = useMemo(() => (index ? createRouter(index) : null), [index]);
  const tools = useMemo(() => (index ? createTools({ index, router }) : null), [index, router]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [busLine, setBusLine] = useState<LatLng[] | null>(null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PlaceHit[] | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [route, setRoute] = useState<Route | null>(null);

  const [position, setPosition] = useState<Position>(VENUE);
  const [gstate, setGstate] = useState<GuidanceState | null>(null);
  const [walking, setWalking] = useState<'idle' | 'running' | 'paused'>('idle');
  const [sourceKind, setSourceKind] = useState<'simulated' | 'gps'>('simulated');
  const [speed, setSpeed] = useState(4);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [announcement, setAnnouncement] = useState('');

  const sourceRef = useRef<PositionSource | null>(null);
  const guidanceRef = useRef<Guidance | null>(null);
  const unsubPosRef = useRef<(() => void) | null>(null);
  const promptId = useRef(0);

  // ---- output: every prompt goes to the screen, the live region and speech
  const speak = (req: SpeakRequest) => {
    setPrompts((p) => [{ id: promptId.current++, text: req.text, milestone: req.milestone }, ...p].slice(0, 8));
    setAnnouncement(req.text);
    speakFallback(req, profile);
  };

  useEffect(() => {
    loadPack()
      .then((ix) => {
        setIndex(ix);
        setAnnouncement(`Area map loaded: ${ix.pack.name}. ${ix.pack.places.length} places.`);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(
    () =>
      connectivity.subscribe((m) =>
        setAnnouncement(m === 'offline' ? 'You are offline. Navigation and questions still work.' : 'Back online. Live features are available.'),
      ),
    [],
  );

  // ---- search and route
  const search = (e?: FormEvent) => {
    e?.preventDefault();
    if (!index || !router || !query.trim()) return;
    const found = findPlaces(index, router, position, query, 5);
    setHits(found);
    if (!found.length) speak({ text: `I couldn't find "${query}" in the downloaded area.` });
    else {
      const h = found[0];
      speak({ text: `${found.length} result${found.length === 1 ? '' : 's'}. Nearest: ${h.place.name}, about ${Math.round((h.walkMeters ?? h.straightMeters) / 10) * 10} metres walk.` });
    }
  };

  const planRoute = (dest: Place, prof: RouteProfileId, from: Position = position) => {
    if (!router) return null;
    const r = router.route(from, dest, prof, dest.name);
    if (!r) {
      speak({ text: `There is no ${PROFILE_LABELS[prof].toLowerCase()} route to ${dest.name} in the downloaded area.` });
      return null;
    }
    setRoute(r);
    return r;
  };

  const choose = (dest: Place) => {
    stopWalk();
    setDestination(dest);
    const r = planRoute(dest, profile.routeProfile);
    if (r) speak({ text: `${r.waypoints[0]?.instruction ?? ''}${r.tradeOff ? ` ${r.tradeOff}` : ''}` });
  };

  const changeProfile = (prof: RouteProfileId) => {
    setProfile((p) => ({ ...p, routeProfile: prof }));
    if (!destination) return;
    stopWalk();
    const r = planRoute(destination, prof);
    if (r) speak({ text: r.tradeOff ?? `${PROFILE_LABELS[prof]} route: ${r.lengthMeters} metres, ${r.crossings} crossings.` });
  };

  // ---- walking
  function stopWalk() {
    guidanceRef.current?.stop();
    sourceRef.current?.stop();
    unsubPosRef.current?.();
    guidanceRef.current = null;
    sourceRef.current = null;
    unsubPosRef.current = null;
    setWalking('idle');
    setGstate(null);
  }

  const startWalk = (r: Route | null = route) => {
    if (!r) return;
    stopWalk();
    const src: PositionSource = sourceKind === 'gps' ? createGpsSource() : createSimWalk(r.path, { speedFactor: speed });
    const g = createGuidance({
      route: r,
      source: src,
      onSpeak: speak,
      onState: setGstate,
      reassuranceEveryMeters: profile.reassuranceEveryMeters,
    });
    unsubPosRef.current = src.subscribe(setPosition);
    sourceRef.current = src;
    guidanceRef.current = g;
    g.start();
    src.start();
    setWalking('running');
  };

  const reroute = () => {
    if (!destination) return;
    const from = sourceRef.current?.current() ?? position;
    const r = planRoute(destination, profile.routeProfile, from);
    if (r) {
      speak({ text: 'New route from here.', priority: 'interrupt' });
      startWalk(r);
    }
  };

  const sim = () => (sourceRef.current?.kind === 'simulated' ? (sourceRef.current as SimWalk) : null);
  const pauseResume = () => {
    const s = sim();
    if (!s) return;
    if (s.isRunning()) {
      s.pause();
      setWalking('paused');
    } else {
      s.resume();
      setWalking('running');
    }
  };
  const changeSpeed = (f: number) => {
    setSpeed(f);
    sim()?.setSpeedFactor(f);
  };

  useEffect(() => {
    if (gstate?.arrived) setWalking('idle');
  }, [gstate?.arrived]);

  useEffect(() => () => stopWalk(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const nextStep = () => speak({ text: guidanceRef.current?.nextStep() ?? 'Choose a destination first.' });
  const repeat = () => speak({ text: guidanceRef.current?.lastPrompt() ?? prompts[0]?.text ?? 'Nothing to repeat yet.' });

  // ---- asking (F4): every intent runs through the same tool layer
  const navigateTo = (q: string): ToolResult => {
    if (!index || !router) return { ok: false, intent: 'navigateTo', say: 'The map is still loading.' };
    const found = findPlaces(index, router, position, q, 5);
    setHits(found);
    setQuery(q);
    if (!found.length) return { ok: false, intent: 'navigateTo', say: `I couldn't find ${q} in the downloaded area.` };
    choose(found[0].place);
    return { ok: true, intent: 'navigateTo', say: '' }; // choose() already spoke the route
  };

  const onIntent = async (intent: Intent) => {
    if (!index || !tools) return;
    const res = await runIntent(intent, {
      index,
      tools,
      here: sourceRef.current?.current() ?? position,
      guidance: guidanceRef.current,
      lastSaid: prompts[0]?.text ?? null,
      navigateTo,
      openHelp: () => setHelpOpen(true),
    });
    if (res.say) speak({ text: res.say, milestone: res.milestone });
    if (res.intent === 'nearest' && Array.isArray(res.data)) setHits(res.data);
  };

  const highlights = destination ? [destination] : (hits ?? []).map((h) => h.place);

  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>
      <header className="app-header">
        <h1>Offline navigation</h1>
        <div className={`net-status net-${mode}`} aria-hidden="true">
          {mode === 'online' ? 'Online' : 'Offline'}
        </div>
        <label className="switch">
          <input type="checkbox" checked={mode === 'offline'} disabled={!connectivity.browserOnline()} onChange={(e) => connectivity.forceOffline(e.target.checked)} />
          <span>Wi-Fi off (demo)</span>
        </label>
      </header>

      <main id="main" className="app-main">
        <div className="sr-live" role="status" aria-live="polite">
          {announcement}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="layout">
          <div className="controls">
            {helpOpen && (
              <HelpPanel here={position} street={index?.streetAt(position, 40)?.name ?? null} profile={profile} onClose={() => setHelpOpen(false)} />
            )}

            <AskPanel disabled={!index} onIntent={onIntent} />

            <section aria-labelledby="where-h" className="panel">
              <h2 id="where-h">Where to?</h2>
              <form onSubmit={search} className="search">
                <label htmlFor="q" className="visually-hidden">
                  Place name or kind of place
                </label>
                <input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tesco, pharmacy, toilets…" autoComplete="off" disabled={!index} />
                <button type="submit" className="big" disabled={!index}>
                  Search
                </button>
              </form>
              {hits && hits.length > 0 && (
                <ul className="results" aria-label="Search results">
                  {hits.map((h) => (
                    <li key={h.place.id}>
                      <button type="button" className={destination?.id === h.place.id ? 'result chosen' : 'result'} aria-pressed={destination?.id === h.place.id} onClick={() => choose(h.place)}>
                        <strong>{h.place.name}</strong>
                        <span>{Math.round((h.walkMeters ?? h.straightMeters) / 10) * 10} m walk</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="prof-h" className="panel">
              <fieldset className="profiles">
                <legend id="prof-h">Route type</legend>
                {PROFILES.map((p) => (
                  <label key={p} className="radio">
                    <input type="radio" name="profile" value={p} checked={profile.routeProfile === p} onChange={() => changeProfile(p)} />
                    {PROFILE_LABELS[p]}
                  </label>
                ))}
              </fieldset>
              {route && (
                <p className="route-summary">
                  {route.lengthMeters} m · {Math.round(route.durationSeconds / 60)} min · {route.crossings} crossing{route.crossings === 1 ? '' : 's'} ({route.signalledCrossings} with signals)
                  {route.tradeOff && (
                    <>
                      <br />
                      {route.tradeOff}
                    </>
                  )}
                </p>
              )}
            </section>

            <section aria-labelledby="walk-h" className="panel">
              <h2 id="walk-h">Walk</h2>
              <fieldset className="profiles">
                <legend>Position from</legend>
                <label className="radio">
                  <input type="radio" name="src" checked={sourceKind === 'simulated'} onChange={() => setSourceKind('simulated')} disabled={walking !== 'idle'} />
                  Simulated walk
                </label>
                <label className="radio">
                  <input type="radio" name="src" checked={sourceKind === 'gps'} onChange={() => setSourceKind('gps')} disabled={walking !== 'idle' || !gpsAvailable()} />
                  Real GPS
                </label>
              </fieldset>
              <div className="button-row">
                {walking === 'idle' ? (
                  <button type="button" className="big" onClick={() => startWalk()} disabled={!route}>
                    Start
                  </button>
                ) : (
                  <>
                    {sourceKind === 'simulated' && (
                      <button type="button" className="big" onClick={pauseResume}>
                        {walking === 'paused' ? 'Resume' : 'Pause'}
                      </button>
                    )}
                    <button type="button" onClick={stopWalk}>
                      Stop
                    </button>
                  </>
                )}
                <button type="button" onClick={nextStep} disabled={!route}>
                  What next?
                </button>
                <button type="button" onClick={repeat}>
                  Repeat
                </button>
                {gstate?.offRoute && (
                  <button type="button" className="big warn" onClick={reroute}>
                    Reroute
                  </button>
                )}
              </div>
              {sourceKind === 'simulated' && walking !== 'idle' && (
                <div className="button-row" role="group" aria-label="Demo controls">
                  <span>Speed:</span>
                  {SPEEDS.map((f) => (
                    <button key={f} type="button" aria-pressed={speed === f} className={speed === f ? 'chosen' : ''} onClick={() => changeSpeed(f)}>
                      {f}×
                    </button>
                  ))}
                  <button type="button" onClick={() => sim()?.setSidestep(sim() && gstate?.offRoute ? 0 : 40)}>
                    {gstate?.offRoute ? 'Step back on route' : 'Step off route'}
                  </button>
                  <button type="button" onClick={() => sim()?.setAccuracy(gstate?.poorGps ? null : 45)}>
                    {gstate?.poorGps ? 'Good GPS' : 'Poor GPS'}
                  </button>
                </div>
              )}
              {gstate && (
                <p className="route-summary">
                  {gstate.arrived ? 'Arrived.' : `${gstate.remainingMeters} m to go`}
                  {gstate.offRoute && ' · off route'}
                  {gstate.poorGps && ' · poor GPS'}
                </p>
              )}
            </section>

            {index && (
              <BusPanel index={index} here={position} speedFactor={speed} speak={speak} onPosition={setPosition} onLine={setBusLine} />
            )}

            <section aria-labelledby="prompts-h" className="panel">
              <h2 id="prompts-h">Prompts</h2>
              {prompts.length === 0 ? (
                <p className="muted">Spoken prompts appear here.</p>
              ) : (
                <ol className="prompts" reversed>
                  {prompts.map((p) => (
                    <li key={p.id}>
                      {p.milestone && <span className={`earcon earcon-${p.milestone}`}>{MILESTONE_LABEL[p.milestone]}</span>}
                      {p.text}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section aria-labelledby="map-h" className="panel map-panel">
            <h2 id="map-h">Map</h2>
            {index ? (
              <MapView index={index} position={position} route={route} highlights={highlights} lines={busLine ? [busLine] : []} />
            ) : (
              !error && <p>Loading the area map…</p>
            )}
            <p className="sim-label">
              {walking !== 'idle' && sourceKind === 'simulated'
                ? 'Simulated walk: positions are generated along the route at walking pace, with GPS-like jitter.'
                : sourceKind === 'gps'
                  ? 'Real GPS.'
                  : 'Position: Marshgate, UCL East, until a walk starts.'}
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
