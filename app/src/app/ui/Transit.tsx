// Public transport and taxi, on the place card: "How to get there" (Walk /
// Public transport / Taxi), TfL journey options, and the taxi hand-off. Also
// the card for a Tube or train leg, where there is no GPS to follow.

import { MODE_ICON, MODE_WORD, fmtClock, legName, type Journey, type Leg } from '../../transit/journeys';
import { Icon } from './Controls';

export type Travel = 'walk' | 'transit' | 'taxi';

export function TravelChoice({ travel, onTravel }: { travel: Travel; onTravel: (t: Travel) => void }) {
  const opts: Array<[Travel, string, string]> = [
    ['walk', 'Walk', 'directions_walk'],
    ['transit', 'Public transport', 'directions_bus'],
    ['taxi', 'Taxi', 'local_taxi'],
  ];
  return (
    <fieldset className="choice-set">
      <legend>How to get there</legend>
      <div className="choice-row">
        {opts.map(([v, label, icon]) => (
          <label key={v} className="choice">
            <input type="radio" name="travel" value={v} checked={travel === v} onChange={() => onTravel(v)} />
            <Icon name={icon} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** "Walk 8 · Bus 108 · Walk 10" as icon chips. */
function LegChips({ legs }: { legs: Leg[] }) {
  return (
    <span className="leg-chips" aria-hidden="true">
      {legs.map((l, i) => (
        <span key={i} className="leg-chip-wrap">
          {i > 0 && <Icon name="chevron_right" size={18} />}
          <span className={`leg-chip ${l.mode === 'walking' ? 'walk' : 'ride'}`}>
            <Icon name={MODE_ICON[l.mode]} size={20} />
            {l.mode === 'walking' ? `${l.minutes}` : (l.line ?? MODE_WORD[l.mode])}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Words for one leg, for the list item's accessible name and the steps list. */
export function legWords(l: Leg): { icon: string; title: string; detail: string } {
  if (l.mode === 'walking') return { icon: 'directions_walk', title: `Walk ${l.minutes} min`, detail: `to ${l.to.name}` };
  const n = l.stops.length;
  const what = legName(l).replace(/^(the|a) /, '');
  return {
    icon: MODE_ICON[l.mode],
    title: `${what.charAt(0).toUpperCase()}${what.slice(1)}${l.towards ? ` towards ${l.towards}` : ''}`,
    detail: `From ${[l.from.name, l.from.indicator].filter(Boolean).join(', ')} · ${n} stop${n === 1 ? '' : 's'} to ${l.to.name} · ${fmtClock(l.departure)}`,
  };
}

export interface TransitPanelProps {
  state: 'loading' | 'ok' | 'error';
  journeys: Journey[];
  message: string | null;
  selected: number;
  onSelect: (i: number) => void;
  onStart: () => void;
  stepFree: boolean;
}

export function TransitPanel(p: TransitPanelProps) {
  if (p.state === 'loading') return <p style={{ margin: 0, fontSize: 18 }}>Asking TfL for routes…</p>;
  if (p.state === 'error') return <p className="warn-text">{p.message}</p>;
  const j = p.journeys[p.selected];
  return (
    <>
      <ul className="rows ruled" aria-label="Public transport options">
        {p.journeys.map((jj, i) => {
          const spoken = jj.legs.map((l) => (l.mode === 'walking' ? `walk ${l.minutes} minutes` : legName(l))).join(', then ');
          return (
            <li key={i}>
              <button
                type="button"
                className={`row-btn tall journey${i === p.selected ? ' chosen' : ''}`}
                aria-pressed={i === p.selected}
                aria-label={`${jj.minutes} minutes, ${fmtClock(jj.start)} to ${fmtClock(jj.arrive)}: ${spoken}${jj.legs.some((l) => l.disrupted) ? '. Disruption reported' : ''}`}
                onClick={() => p.onSelect(i)}
              >
                <span className="row-main">
                  <strong>
                    {jj.minutes} min · {fmtClock(jj.start)}–{fmtClock(jj.arrive)}
                  </strong>
                  <LegChips legs={jj.legs} />
                </span>
                {jj.legs.some((l) => l.disrupted) && (
                  <span className="row-end" aria-hidden="true">
                    <Icon name="warning" />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {j && (
        <ol className="rows steps-list" aria-label="Journey steps">
          {j.legs.map((l, i) => {
            const w = legWords(l);
            return (
              <li key={i}>
                <span className="step-icon" aria-hidden="true">
                  <Icon name={w.icon} />
                </span>
                <span className="row-main">
                  <strong>{w.title}</strong>
                  <span className="row-meta">{w.detail}</span>
                </span>
                <span className="step-at">{l.minutes} min</span>
              </li>
            );
          })}
        </ol>
      )}
      <button type="button" className="btn primary big" onClick={p.onStart} disabled={!j}>
        <Icon name="directions_bus" />
        Start journey
      </button>
      <p className="fine">
        Live from TfL{p.stepFree ? ', step-free to the vehicle, no stairs or escalators' : ''}, at a slow walking pace. Tube and train legs: no GPS underground, so count the stops or listen for announcements.
      </p>
    </>
  );
}

export interface TaxiPanelProps {
  offline: boolean;
  uberHref: string;
  destination: string;
  copied: boolean;
  onCopy: () => void;
}

export function TaxiPanel(p: TaxiPanelProps) {
  return (
    <>
      {p.offline && <p className="warn-text">Taxi apps need a connection. Walking directions still work offline.</p>}
      <a className={`btn primary big${p.offline ? ' disabled' : ''}`} href={p.uberHref} target="_blank" rel="noreferrer" aria-disabled={p.offline}>
        <Icon name="local_taxi" />
        Open Uber with this trip
        <Icon name="open_in_new" />
      </a>
      <button type="button" className="btn outline" onClick={p.onCopy}>
        <Icon name={p.copied ? 'check' : 'content_copy'} />
        {p.copied ? 'Destination copied' : 'Copy destination for any taxi'}
      </button>
      <p className="fine">You check and book in the taxi app. This app never books, pays or sends anything. {p.destination}</p>
    </>
  );
}

export interface RailStepCardProps {
  leg: Leg;
  legNo: number;
  legs: number;
  onArrived: () => void;
  onEnd: () => void;
  onRepeat: () => void;
}

/** A Tube or train leg: no GPS underground, so the person says when they are off. */
export function RailStepCard(p: RailStepCardProps) {
  return (
    <section className="card" aria-labelledby="rail-h" style={{ padding: '16px 18px 18px', gap: 14 }}>
      <div className="nav-head">
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <h2 id="rail-h" tabIndex={-1} className="nav-min">
            {p.leg.stops.length} stops to {p.leg.to.name}
          </h2>
          <span className="nav-meta">
            Step {p.legNo} of {p.legs} · no GPS underground: count the stops or listen for announcements
          </span>
        </div>
        <button type="button" className="btn danger" onClick={p.onEnd}>
          End journey
        </button>
      </div>
      <button type="button" className="btn primary big" onClick={p.onArrived}>
        <Icon name="check" />
        I'm off at {p.leg.to.name}
      </button>
      <div className="tiles" style={{ gridTemplateColumns: '1fr' }}>
        <button type="button" className="tile" onClick={p.onRepeat}>
          <Icon name="replay" />
          Repeat
        </button>
      </div>
    </section>
  );
}
