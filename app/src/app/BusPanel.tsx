// Bus (F8 stop countdown, F9 arrivals). Pick the stop you're at, the bus, and
// where to get off; the phone counts the stops down, offline. The demo rides
// a simulated bus along the stops; with real GPS on a phone the same code
// follows the real bus.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BusRoute, BusStop, LatLng, Position, SpeakRequest } from '../contracts';
import type { PackIndex } from '../pack/pack';
import { busArrivals, routesAt } from '../transit/arrivals';
import { createBusRide, planBusRide, type BusRideState } from '../transit/busRide';
import { createSimWalk, type SimWalk } from '../sim/simWalk';

export interface BusPanelProps {
  index: PackIndex;
  here: Position;
  speedFactor: number;
  speak: (req: SpeakRequest) => void;
  onPosition: (p: Position) => void;
  /** The stop-to-stop line of the ride, for the map (null to clear). */
  onLine: (line: LatLng[] | null) => void;
}

const BUS_SPEED = 6; // m/s, about 13 mph including stops
const stopLabel = (s: BusStop) => [s.name, s.indicator].filter(Boolean).join(', ');

export function BusPanel({ index, here, speedFactor, speak, onPosition, onLine }: BusPanelProps) {
  const [stopId, setStopId] = useState<string | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [alightId, setAlightId] = useState<string | null>(null);
  const [ride, setRide] = useState<BusRideState | null>(null);
  const simRef = useRef<SimWalk | null>(null);
  const rideRef = useRef<ReturnType<typeof createBusRide> | null>(null);
  // The stop list follows the person, except during a ride (the bus moves away from the stop).
  const [anchor, setAnchor] = useState<LatLng>(here);
  useEffect(() => {
    if (!simRef.current) setAnchor({ lat: here.lat, lng: here.lng });
  }, [here.lat, here.lng]);
  const nearStops = useMemo(() => index.busStopsNear(anchor, 400, 4), [index, anchor]);

  const stop = nearStops.find((s) => s.stop.id === stopId)?.stop ?? nearStops[0]?.stop ?? null;
  const routes: BusRoute[] = stop ? routesAt(index, stop) : [];
  const route = routes.find((r) => r.id === routeId) ?? null;
  const ahead = useMemo(() => {
    if (!route || !stop) return [];
    const i = route.stops.indexOf(stop.id);
    const byId = new Map(index.pack.busStops.map((s) => [s.id, s]));
    return route.stops.slice(i + 1, i + 16).map((id) => byId.get(id)).filter((s): s is BusStop => !!s);
  }, [route, stop, index]);

  const stopRide = () => {
    rideRef.current?.stop();
    simRef.current?.stop();
    rideRef.current = null;
    simRef.current = null;
    setRide(null);
    onLine(null);
  };
  useEffect(() => () => stopRide(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => simRef.current?.setSpeedFactor(speedFactor), [speedFactor]);

  const startRide = () => {
    if (!route || !stop || !alightId) return;
    const plan = planBusRide(index, route, stop.id, alightId);
    if (!plan) return speak({ text: 'That bus does not go to that stop from here.' });
    stopRide();
    const sim = createSimWalk(plan.line, { speed: BUS_SPEED, speedFactor, jitterMeters: 4 });
    sim.subscribe(onPosition);
    const r = createBusRide({ plan, source: sim, onSpeak: speak, onState: setRide });
    simRef.current = sim;
    rideRef.current = r;
    onLine(plan.line);
    r.start();
    sim.start();
  };

  if (!nearStops.length) {
    return (
      <section aria-labelledby="bus-h" className="panel">
        <h2 id="bus-h">Bus</h2>
        <p className="muted">No bus stop within 400 metres.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="bus-h" className="panel">
      <h2 id="bus-h">Bus</h2>
      <label className="field">
        <span>Stop</span>
        <select value={stop?.id ?? ''} onChange={(e) => (setStopId(e.target.value), setRouteId(null), setAlightId(null))}>
          {nearStops.map(({ stop: s, meters }) => (
            <option key={s.id} value={s.id}>
              {stopLabel(s)} {s.towards ? `(${s.towards})` : ''} · {Math.round(meters)} m
            </option>
          ))}
        </select>
      </label>
      {stop && (
        <div className="button-row">
          <button type="button" onClick={async () => speak({ text: (await busArrivals(index, stop)).say })}>
            Next buses here
          </button>
        </div>
      )}
      {routes.length > 0 && (
        <label className="field">
          <span>Bus</span>
          <select value={routeId ?? ''} onChange={(e) => (setRouteId(e.target.value || null), setAlightId(null))}>
            <option value="">Choose a bus…</option>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} to {r.destination}
              </option>
            ))}
          </select>
        </label>
      )}
      {route && ahead.length > 0 && (
        <label className="field">
          <span>Get off at</span>
          <select value={alightId ?? ''} onChange={(e) => setAlightId(e.target.value || null)}>
            <option value="">Choose a stop…</option>
            {ahead.map((s, i) => (
              <option key={s.id} value={s.id}>
                {i + 1}. {stopLabel(s)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="button-row">
        {ride && !ride.arrived ? (
          <button type="button" onClick={stopRide}>
            Stop ride
          </button>
        ) : (
          <button type="button" className="big" onClick={startRide} disabled={!alightId}>
            Start ride (simulated)
          </button>
        )}
      </div>
      {ride && (
        <p className="route-summary">
          {ride.arrived ? 'At your stop.' : `${ride.stopsLeft} stop${ride.stopsLeft === 1 ? '' : 's'} to go · next: ${ride.nextStop?.name ?? ''}`}
        </p>
      )}
    </section>
  );
}
