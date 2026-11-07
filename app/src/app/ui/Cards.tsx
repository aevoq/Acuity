// The bottom cards, one at a time: Explore, Answer, Results, Place, Arrived.
// Each card's heading has an id and tabIndex -1: the shell moves focus to it
// when the card changes, so a screen-reader user hears where they are.

import type { BusRoute, BusStop, LatLng, Route, RouteProfileId } from '../../contracts';
import { categoryColor } from '../../mapview/MapCanvas';
import { PROFILE_LABELS } from '../../nav/costs';
import { Icon } from './Controls';
import { catIcon, catLabel, directionFrom, fmtDist, targetName, walkMinutes, type Answer, type ResultItem, type Target } from './model';

// ---------------------------------------------------------------- Explore
export interface ExploreCardProps {
  hereName: string;
  hereSub: string;
  onAsk: (kind: 'where' | 'around' | 'bus' | 'toilets') => void;
}

const ASKS = [
  { kind: 'where', label: 'Where am I?', icon: 'person_pin_circle' },
  { kind: 'around', label: "What's around me?", icon: 'explore' },
  { kind: 'bus', label: 'Nearest bus stop', icon: 'directions_bus' },
  { kind: 'toilets', label: 'Nearest toilets', icon: 'wc' },
] as const;

export function ExploreCard({ hereName, hereSub, onAsk }: ExploreCardProps) {
  return (
    <section className="card" aria-labelledby="here-h" style={{ paddingTop: 8 }}>
      <div className="grabber" aria-hidden="true" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="eyebrow">You are here</span>
        <h1 id="here-h" tabIndex={-1} style={{ fontSize: 26, lineHeight: 1.15 }}>
          {hereName}
        </h1>
        <span className="muted" style={{ fontSize: 17 }}>
          {hereSub}
        </span>
      </div>
      <div className="ask-grid" role="group" aria-label="Ask">
        {ASKS.map((a) => (
          <button key={a.kind} type="button" className="ask-btn" onClick={() => onAsk(a.kind)}>
            <Icon name={a.icon} />
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Answer
export interface AnswerCardProps {
  answer: Answer;
  me: LatLng;
  onClose: () => void;
  onSayAgain: () => void;
  onChoose: (t: Target) => void;
}

export function AnswerCard({ answer, me, onClose, onSayAgain, onChoose }: AnswerCardProps) {
  return (
    <section className="card scroll" aria-labelledby="ans-h">
      <div className="card-head">
        <Icon name={answer.icon} />
        <h2 id="ans-h" tabIndex={-1} style={{ fontSize: 18, color: '#4a4a4a', flex: 1 }}>
          {answer.q}
        </h2>
        <button type="button" className="round-btn" aria-label="Close answer" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <p className="answer-text">{answer.text}</p>
      {answer.items.length > 0 && (
        <ul className="rows ruled">
          {answer.items.map(({ target, meters }) => (
            <li key={target.id}>
              <button type="button" className="row-btn" onClick={() => onChoose(target)}>
                <span className="badge" style={{ background: categoryColor(target.category) }} aria-hidden="true">
                  <Icon name={catIcon(target.category)} />
                </span>
                <span className="row-main">
                  <strong>{targetName(target)}</strong>
                  <span className="row-meta">
                    {catLabel(target.category)} · {fmtDist(meters)} {directionFrom(me, target)}
                  </span>
                </span>
                <Icon name="chevron_right" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="btn-row">
        <button type="button" className="btn outline" onClick={onSayAgain}>
          <Icon name="replay" />
          Say again
        </button>
        {answer.goTo && (
          <button type="button" className="btn primary" onClick={() => onChoose(answer.goTo!)}>
            <Icon name="directions_walk" />
            Walk there
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Results
export interface ResultsCardProps {
  title: string;
  results: ResultItem[];
  me: LatLng;
  onClose: () => void;
  onChoose: (t: Target) => void;
}

export function ResultsCard({ title, results, me, onClose, onChoose }: ResultsCardProps) {
  return (
    <section className="card scroll" aria-labelledby="res-h" style={{ padding: '16px 20px 8px', gap: 4 }}>
      <div className="card-head">
        <h2 id="res-h" tabIndex={-1} style={{ fontSize: 22, flex: 1 }}>
          {title}
        </h2>
        <button type="button" className="round-btn" aria-label="Close results" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {results.length === 0 && (
        <p style={{ margin: '4px 0 12px', fontSize: 18 }} className="muted">
          Nothing matched in the downloaded area. Try a kind of place, like “chemist” or “coffee”.
        </p>
      )}
      <ol className="rows top-ruled" aria-label="Search results">
        {results.map((r, i) => (
          <li key={r.target.id}>
            <button type="button" className="row-btn tall" onClick={() => onChoose(r.target)}>
              <span className="badge num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="row-main">
                <strong>{targetName(r.target)}</strong>
                <span className="row-meta">
                  {catLabel(r.target.category)} · {fmtDist(r.walk)} · {directionFrom(me, r.target)}
                </span>
              </span>
              <span className="row-end">
                <strong>{walkMinutes(r.walk)} min</strong>
                <span>walk</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- Place
const PROFILE_ICONS: Record<RouteProfileId, string> = {
  shortest: 'straighten',
  fewestCrossings: 'traffic',
  stepFree: 'accessible',
  mainRoads: 'add_road',
  restStops: 'chair',
};
const PROFILE_ORDER: RouteProfileId[] = ['shortest', 'fewestCrossings', 'stepFree', 'mainRoads', 'restStops'];

export interface BusSetup {
  arrivals: string | null;
  loadingArrivals: boolean;
  onNextBuses: () => void;
  routes: BusRoute[];
  routeId: string | null;
  onRoute: (id: string | null) => void;
  ahead: BusStop[];
  alightId: string | null;
  onAlight: (id: string | null) => void;
  onStartRide: () => void;
}

export interface PlaceCardProps {
  target: Target;
  route: Route | null;
  noRouteText: string | null;
  profile: RouteProfileId;
  onProfile: (p: RouteProfileId) => void;
  onStart: () => void;
  showSteps: boolean;
  onToggleSteps: () => void;
  onBack: () => void;
  bus: BusSetup | null;
}

export function PlaceCard(p: PlaceCardProps) {
  const { target, route } = p;
  const lines = target.stop?.lines?.length ? ` · Buses ${target.stop.lines.join(', ')}` : '';
  const towards = target.stop?.towards ? ` · ${target.stop.towards}` : '';
  return (
    <section className="card tall" aria-labelledby="place-h" style={{ padding: '16px 20px 20px', gap: 14 }}>
      <div className="card-head top">
        <button type="button" className="round-btn" aria-label="Back" onClick={p.onBack}>
          <Icon name="arrow_back" />
        </button>
        <div className="grow">
          <h2 id="place-h" tabIndex={-1} className="place-title">
            {targetName(target)}
          </h2>
          <span className="muted" style={{ fontSize: 17 }}>
            {catLabel(target.category)}
            {lines}
            {towards}
          </span>
        </div>
      </div>

      {route && (
        <div className="route-sum">
          <div className="line">
            <span className="route-min">{walkMinutes(route.lengthMeters)} min</span>
            <span className="route-len">{fmtDist(route.lengthMeters)}</span>
          </div>
          <span style={{ fontSize: 18 }}>
            {route.crossings} crossing{route.crossings === 1 ? '' : 's'} · {route.signalledCrossings} with signals
          </span>
          {route.tradeOff && <span className="small">{route.tradeOff}</span>}
        </div>
      )}
      {!route && p.noRouteText && <p className="warn-text">{p.noRouteText}</p>}

      <div className="btn-row">
        <button type="button" className="btn primary big grow" onClick={p.onStart} disabled={!route}>
          <Icon name="directions_walk" />
          Start walking
        </button>
        <button type="button" className="btn outline big" aria-expanded={p.showSteps} onClick={p.onToggleSteps} disabled={!route}>
          <Icon name="format_list_bulleted" />
          Steps
        </button>
      </div>

      <fieldset className="choice-set">
        <legend>Route type</legend>
        <div className="choice-row">
          {PROFILE_ORDER.map((id) => (
            <label key={id} className="choice">
              <input type="radio" name="route-type" value={id} checked={p.profile === id} onChange={() => p.onProfile(id)} />
              <Icon name={PROFILE_ICONS[id]} />
              {PROFILE_LABELS[id]}
            </label>
          ))}
        </div>
      </fieldset>

      {p.showSteps && route && (
        <ol className="rows steps-list" aria-label="Route steps">
          {route.waypoints.map((w) => (
            <li key={w.id}>
              <span className="step-icon" aria-hidden="true">
                <Icon name={w.icon ?? 'straight'} />
              </span>
              <span className="row-main">
                <strong>{w.title ?? w.instruction}</strong>
                {w.detail && <span className="row-meta">{w.detail}</span>}
              </span>
              <span className="step-at">{w.kind === 'start' ? 'Start' : fmtDist(w.distanceAlong)}</span>
            </li>
          ))}
        </ol>
      )}

      {p.bus && <BusSection bus={p.bus} />}

      <p className="fine">Crossings are described, never judged safe. Use alongside your cane, dog and training.</p>
    </section>
  );
}

function BusSection({ bus }: { bus: BusSetup }) {
  return (
    <section aria-labelledby="bus-h" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid #e4e0d8', paddingTop: 12 }}>
      <h3 id="bus-h" style={{ margin: 0, fontSize: 20 }}>
        Buses from this stop
      </h3>
      <div className="btn-row">
        <button type="button" className="btn outline" onClick={bus.onNextBuses} disabled={bus.loadingArrivals}>
          <Icon name="schedule" />
          {bus.loadingArrivals ? 'Checking…' : 'Next buses'}
        </button>
      </div>
      {bus.arrivals && <p style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{bus.arrivals}</p>}
      {bus.routes.length > 0 && (
        <>
          <label className="field">
            Ride a bus from here
            <select value={bus.routeId ?? ''} onChange={(e) => bus.onRoute(e.target.value || null)}>
              <option value="">Choose a bus…</option>
              {bus.routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} to {r.destination}
                </option>
              ))}
            </select>
          </label>
          {bus.routeId && (
            <label className="field">
              Get off at
              <select value={bus.alightId ?? ''} onChange={(e) => bus.onAlight(e.target.value || null)}>
                <option value="">Choose a stop…</option>
                {bus.ahead.map((s, i) => (
                  <option key={s.id} value={s.id}>
                    {i + 1}. {s.name}
                    {s.indicator ? `, ${s.indicator}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="btn primary" onClick={bus.onStartRide} disabled={!bus.alightId}>
            <Icon name="directions_bus" />
            Start bus ride
          </button>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Arrived
export function ArrivedCard({ name, onDone }: { name: string; onDone: () => void }) {
  return (
    <section className="card" aria-labelledby="arr-h" style={{ padding: 20, gap: 14 }}>
      <div className="card-head">
        <span className="arrived-mark" aria-hidden="true">
          <Icon name="flag" />
        </span>
        <div className="grow">
          <h2 id="arr-h" tabIndex={-1} style={{ fontSize: 26 }}>
            You have arrived
          </h2>
          <span style={{ fontSize: 18, color: '#333' }}>{name}</span>
        </div>
      </div>
      <button type="button" className="btn primary" style={{ minHeight: 56, fontSize: 19 }} onClick={onDone}>
        Done
      </button>
    </section>
  );
}
