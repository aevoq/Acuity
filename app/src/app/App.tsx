// The page shell. Owns layout, the online/offline switch, the live region and
// the map. Feature folders (voice, agent, nav, sim, vision) plug in here.
//
// Accessibility basics this shell guarantees:
//  - one <h1>, landmarks (header / main), a skip link;
//  - every status change is mirrored into a polite live region, so screen
//    reader users hear it in their own voice (principle 6);
//  - controls are real buttons, 48 px or larger, reachable by keyboard.

import { useEffect, useState } from 'react';
import type { LatLng, Position } from '../contracts';
import { distance } from '../geo/geo';
import { MapView } from '../mapview/MapView';
import { connectivity } from '../net/connectivity';
import { useNetworkMode } from '../net/useConnectivity';
import { loadPack, type PackIndex } from '../pack/pack';
import './app.css';

/** Until a PositionSource is wired, the user "stands" at the venue entrance. */
const VENUE: Position = { lat: 51.537542, lng: -0.0119821, accuracy: 5, heading: null, speed: null, timestamp: 0, source: 'simulated' };

export function App() {
  const mode = useNetworkMode();
  const [index, setIndex] = useState<PackIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [answer, setAnswer] = useState<{ text: string; at: LatLng | null } | null>(null);
  const position = VENUE;

  useEffect(() => {
    loadPack()
      .then((ix) => {
        setIndex(ix);
        setAnnouncement(`Area map loaded: ${ix.pack.name}. ${ix.pack.places.length} places.`);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // Announce every online/offline change.
  useEffect(
    () =>
      connectivity.subscribe((m) =>
        setAnnouncement(m === 'offline' ? 'You are offline. Navigation and questions still work.' : 'Back online. Live features are available.'),
      ),
    [],
  );

  // F1 acceptance check: answer "nearest Tesco" from the pack alone.
  // (Straight-line for now; the router replaces this with walking distance.)
  const nearestTesco = () => {
    if (!index) return;
    const hits = index.pack.places
      .filter((p) => /tesco/i.test(`${p.name} ${p.brand ?? ''}`) && !/bank/i.test(p.name))
      .map((p) => ({ p, d: distance(position, p) }))
      .sort((a, b) => a.d - b.d);
    const text = hits.length
      ? `The nearest Tesco is ${hits[0].p.name}, about ${Math.round(hits[0].d / 10) * 10} metres away in a straight line.`
      : 'There is no Tesco in the downloaded area.';
    setAnswer({ text, at: hits[0]?.p ?? null });
    setAnnouncement(text);
  };

  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>
      <header className="app-header">
        <h1>Offline navigation</h1>
        <div className={`net-status net-${mode}`} aria-hidden="true">
          {mode === 'online' ? 'Online' : 'Offline'}
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={mode === 'offline'}
            disabled={!connectivity.browserOnline()}
            onChange={(e) => connectivity.forceOffline(e.target.checked)}
          />
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

        <section aria-labelledby="ask-h" className="panel">
          <h2 id="ask-h">Ask</h2>
          <button type="button" className="big" onClick={nearestTesco} disabled={!index}>
            Where's the nearest Tesco?
          </button>
          {answer && <p className="answer">{answer.text}</p>}
        </section>

        <section aria-labelledby="map-h" className="panel">
          <h2 id="map-h">Map</h2>
          {index ? (
            <MapView index={index} position={position} highlights={answer?.at ? [answer.at] : []} />
          ) : (
            !error && <p>Loading the area map…</p>
          )}
          <p className="sim-label">Position: fixed at the venue until the simulated walk is connected.</p>
        </section>
      </main>
    </>
  );
}
