// Always-visible controls: the right-hand column (online/offline, zoom,
// re-centre, settings, SOS) and the search bar with its category chips.

import type { FormEvent } from 'react';

export function Icon({ name, fill, size }: { name: string; fill?: boolean; size?: number }) {
  return (
    <span className={fill ? 'icon icon-fill' : 'icon'} aria-hidden="true" style={size ? { fontSize: size } : undefined}>
      {name}
    </span>
  );
}

export interface RightControlsProps {
  offline: boolean;
  onToggleOffline: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  following: boolean;
  onRecenter: () => void;
  onSettings: () => void;
  onCamera: () => void;
  onHelp: () => void;
  /** True while the app is talking: shows Stop talking. */
  speaking: boolean;
  onStopTalking: () => void;
}

export function RightControls(p: RightControlsProps) {
  return (
    <>
      {p.speaking && (
        <button type="button" className="net-pill stop-talking" onClick={p.onStopTalking} aria-label="Stop talking (Escape)">
          <Icon name="volume_off" />
          <span>Stop talking</span>
        </button>
      )}
      <button
        type="button"
        className={`net-pill ${p.offline ? 'offline' : 'online'}`}
        aria-pressed={p.offline}
        aria-label={p.offline ? 'Offline. Navigation and questions still work. Press to go online.' : 'Online. Press to simulate Wi-Fi off.'}
        onClick={p.onToggleOffline}
      >
        <Icon name={p.offline ? 'cloud_off' : 'cloud_done'} />
        <span>{p.offline ? 'Offline' : 'Online'}</span>
      </button>
      <div className="zoom-box">
        <button type="button" aria-label="Zoom in" onClick={p.onZoomIn}>
          <Icon name="add" />
        </button>
        <button type="button" aria-label="Zoom out" onClick={p.onZoomOut}>
          <Icon name="remove" />
        </button>
      </div>
      <button type="button" className={`square-btn${p.following ? ' following' : ''}`} aria-label="Centre the map on my position" onClick={p.onRecenter}>
        <Icon name="my_location" fill />
      </button>
      <button type="button" className="square-btn" aria-label="Open the camera, to read a traffic light or ask about your surroundings" onClick={p.onCamera}>
        <Icon name="photo_camera" />
      </button>
      <button type="button" className="square-btn" aria-label="Settings: map style, text size, voice" onClick={p.onSettings}>
        <Icon name="settings" />
      </button>
      <button type="button" className="sos-btn" aria-label="Get help: call 999 or text your location" onClick={p.onHelp}>
        SOS
      </button>
    </>
  );
}

export interface SearchBarProps {
  query: string;
  onQuery: (q: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  busy: boolean;
  listening: boolean;
  onMic: () => void;
}

export function SearchBar({ query, onQuery, onSubmit, onClear, busy, listening, onMic }: SearchBarProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form className="searchbar" role="search" onSubmit={submit}>
      <span className="search-lead">
        <Icon name="search" />
      </span>
      <label htmlFor="q" className="visually-hidden">
        Where to? A place, a kind of place, or a question
      </label>
      <input id="q" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Where to? Tesco, pharmacy, toilets…" autoComplete="off" enterKeyHint="search" />
      {query && (
        <button type="button" className="round-btn clear" aria-label="Clear search" onClick={onClear}>
          <Icon name="close" />
        </button>
      )}
      <button
        type="button"
        className={`round-btn mic${listening ? ' on' : ''}`}
        aria-pressed={listening}
        aria-label={listening ? 'Stop listening and search' : 'Speak: a place, or a question like what is on my left'}
        onClick={onMic}
      >
        <Icon name={listening ? 'graphic_eq' : 'mic'} />
      </button>
      <button type="submit" className="search-go" aria-label="Search" disabled={busy}>
        <span className="search-go-text">{busy ? '…' : 'Search'}</span>
        <Icon name="search" />
      </button>
    </form>
  );
}

export const CATEGORIES = [
  { label: 'Supermarket', icon: 'shopping_cart', query: 'supermarket' },
  { label: 'Pharmacy', icon: 'local_pharmacy', query: 'pharmacy' },
  { label: 'Café', icon: 'local_cafe', query: 'cafe' },
  { label: 'Toilets', icon: 'wc', query: 'toilets' },
  { label: 'Bus stops', icon: 'directions_bus', query: 'bus stops' },
  { label: 'Cash', icon: 'local_atm', query: 'cash machine' },
] as const;

export function CategoryChips({ active, onPick }: { active: string | null; onPick: (c: (typeof CATEGORIES)[number]) => void }) {
  return (
    <div className="chips" role="group" aria-label="Find nearby">
      {CATEGORIES.map((c) => (
        <button key={c.label} type="button" className="chip" aria-pressed={active === c.label} onClick={() => onPick(c)}>
          <Icon name={c.icon} />
          {c.label}
        </button>
      ))}
    </div>
  );
}
