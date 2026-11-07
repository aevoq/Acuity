// Walking and bus-ride views: the big green banner at the top (the next
// instruction) and the card at the bottom (time left, Repeat / What next /
// Pause, simulated-walk speed and the demo controls).

import { Icon } from './Controls';

export interface BannerProps {
  icon: string;
  dist: string;
  title: string;
  sub?: string;
  warn?: boolean;
  then?: { icon: string; title: string } | null;
}

/** The next instruction. Its words are already spoken; the banner is for sighted helpers and low vision. */
export function NavBanner({ icon, dist, title, sub, warn, then }: BannerProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className={`banner${warn ? ' warn' : ''}`} role="group" aria-label="Next instruction">
        <Icon name={icon} />
        <div className="banner-text">
          {dist && <span className="banner-dist">{dist}</span>}
          <span className="banner-title">{title}</span>
          {sub && <span className="banner-sub">{sub}</span>}
        </div>
      </div>
      {then && (
        <div className="then-chip">
          <span>Then</span>
          <Icon name={then.icon} />
          <span>{then.title}</span>
        </div>
      )}
    </div>
  );
}

export interface SpeedProps {
  speed: number;
  onSpeed: (f: number) => void;
}

function SpeedChips({ speed, onSpeed, label }: SpeedProps & { label: string }) {
  return (
    <>
      <strong>{label}</strong>
      {[1, 4, 10].map((f) => (
        <button key={f} type="button" className="demo-btn" aria-pressed={speed === f} onClick={() => onSpeed(f)} aria-label={`${f} times speed`}>
          {f}×
        </button>
      ))}
    </>
  );
}

export interface WalkCardProps extends SpeedProps {
  minutes: string;
  meta: string;
  simulated: boolean;
  paused: boolean;
  offRoute: boolean;
  poorGps: boolean;
  onEnd: () => void;
  onRepeat: () => void;
  onWhatNext: () => void;
  onPause: () => void;
  onReroute: () => void;
  onStepOff: () => void;
  onPoorGps: () => void;
}

export function WalkCard(p: WalkCardProps) {
  return (
    <section className="card" aria-labelledby="walk-h" style={{ padding: '16px 18px 18px', gap: 14 }}>
      <div className="nav-head">
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <h2 id="walk-h" tabIndex={-1} className="nav-min">
            {p.minutes}
          </h2>
          <span className="nav-meta">{p.meta}</span>
        </div>
        <button type="button" className="btn danger" onClick={p.onEnd}>
          End walk
        </button>
      </div>
      {p.offRoute && (
        <button type="button" className="btn danger" style={{ minHeight: 56 }} onClick={p.onReroute}>
          <Icon name="alt_route" />
          Reroute from here
        </button>
      )}
      <div className="tiles">
        <button type="button" className="tile" onClick={p.onRepeat}>
          <Icon name="replay" />
          Repeat
        </button>
        <button type="button" className="tile" onClick={p.onWhatNext}>
          <Icon name="record_voice_over" />
          What next?
        </button>
        {p.simulated && (
          <button type="button" className="tile" onClick={p.onPause}>
            <Icon name={p.paused ? 'play_arrow' : 'pause'} fill />
            {p.paused ? 'Resume' : 'Pause'}
          </button>
        )}
      </div>
      {p.simulated && (
        <>
          <div className="demo-row" role="group" aria-label="Simulated walk speed">
            <SpeedChips speed={p.speed} onSpeed={p.onSpeed} label="Simulated walk" />
          </div>
          <div className="demo-row" role="group" aria-label="Demo: show the warnings">
            <strong>Demo</strong>
            <button type="button" className="demo-btn" aria-pressed={p.offRoute} onClick={p.onStepOff}>
              {p.offRoute ? 'Step back on route' : 'Step off route'}
            </button>
            <button type="button" className="demo-btn" aria-pressed={p.poorGps} onClick={p.onPoorGps}>
              {p.poorGps ? 'Good GPS' : 'Poor GPS'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export interface RideCardProps extends SpeedProps {
  title: string;
  meta: string;
  onEnd: () => void;
  onRepeat: () => void;
}

export function RideCard(p: RideCardProps) {
  return (
    <section className="card" aria-labelledby="ride-h" style={{ padding: '16px 18px 18px', gap: 14 }}>
      <div className="nav-head">
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <h2 id="ride-h" tabIndex={-1} className="nav-min">
            {p.title}
          </h2>
          <span className="nav-meta">{p.meta}</span>
        </div>
        <button type="button" className="btn danger" onClick={p.onEnd}>
          End ride
        </button>
      </div>
      <div className="tiles" style={{ gridTemplateColumns: '1fr' }}>
        <button type="button" className="tile" onClick={p.onRepeat}>
          <Icon name="replay" />
          Repeat
        </button>
      </div>
      <div className="demo-row" role="group" aria-label="Simulated bus speed">
        <SpeedChips speed={p.speed} onSpeed={p.onSpeed} label="Simulated ride" />
      </div>
    </section>
  );
}
