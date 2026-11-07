// Help (SOS) and Settings, as native <dialog> elements opened with
// showModal(): the browser traps focus inside, Escape closes them, and focus
// returns to the button that opened them.

import { useEffect, useRef, type ReactNode } from 'react';
import type { MapPalette } from '../../mapview/MapCanvas';
import { TEXT_SIZES, type Settings } from '../settings';
import { Icon } from './Controls';

function Modal({ open, onClose, className, labelledBy, children }: { open: boolean; onClose: () => void; className: string; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`sheet ${className}`} aria-labelledby={labelledBy} onClose={onClose} onCancel={onClose}>
      {open && children}
    </dialog>
  );
}

export interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
  where: string;
  smsHref: string;
}

export function HelpDialog({ open, onClose, where, smsHref }: HelpDialogProps) {
  return (
    <Modal open={open} onClose={onClose} className="help" labelledBy="help-h">
      <div className="sheet-body">
        <h2 id="help-h">Help</h2>
        <p>Each option opens your phone's own screen with the details filled in. Nothing happens until you confirm there.</p>
        <a className="help-call" href="tel:999">
          <Icon name="call" fill />
          Call 999
        </a>
        <a className="help-sms" href={smsHref}>
          <Icon name="sms" />
          Text my location
        </a>
        <p style={{ fontSize: 15, color: '#4a4a4a' }}>Your location: {where}</p>
        <button type="button" className="sheet-close" onClick={onClose}>
          Close help
        </button>
      </div>
    </Modal>
  );
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  gpsAvailable: boolean;
}

export function SettingsDialog({ open, onClose, settings, onChange, gpsAvailable }: SettingsDialogProps) {
  return (
    <Modal open={open} onClose={onClose} className="settings" labelledBy="settings-h">
      <div className="sheet-body">
        <h2 id="settings-h">Settings</h2>

        <fieldset className="choice-set">
          <legend>Map style</legend>
          <div className="choice-row">
            {(
              [
                ['standard', 'Standard'],
                ['highContrast', 'High contrast'],
              ] as Array<[MapPalette, string]>
            ).map(([v, label]) => (
              <label key={v} className="choice dark">
                <input type="radio" name="map-style" checked={settings.mapStyle === v} onChange={() => onChange({ mapStyle: v })} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="choice-set">
          <legend>Text size</legend>
          <div className="choice-row">
            {TEXT_SIZES.map((t) => (
              <label key={t.value} className="choice dark">
                <input type="radio" name="text-size" checked={settings.textSize === t.value} onChange={() => onChange({ textSize: t.value })} />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="switch-row">
          <span>
            I use a screen reader
            <small>The app stays quiet and your screen reader reads every prompt.</small>
          </span>
          <input type="checkbox" checked={settings.screenReader} onChange={(e) => onChange({ screenReader: e.target.checked })} />
        </label>

        <label className="switch-row">
          <span>
            Speak prompts
            <small>{settings.screenReader ? 'Off while the screen reader setting is on.' : 'Uses this device’s voice.'}</small>
          </span>
          <input type="checkbox" checked={settings.voice && !settings.screenReader} disabled={settings.screenReader} onChange={(e) => onChange({ voice: e.target.checked })} />
        </label>

        <label className="field">
          Speech rate: {settings.speechRate.toFixed(1)}×
          <input
            type="range"
            min={0.6}
            max={1.8}
            step={0.1}
            value={settings.speechRate}
            disabled={!settings.voice || settings.screenReader}
            onChange={(e) => onChange({ speechRate: Number(e.target.value) })}
          />
        </label>

        <label className="switch-row">
          <span>
            Use real GPS
            <small>{gpsAvailable ? 'For walking with a phone. Off: a simulated walk for demos.' : 'This browser has no location access.'}</small>
          </span>
          <input type="checkbox" checked={settings.realGps} disabled={!gpsAvailable} onChange={(e) => onChange({ realGps: e.target.checked })} />
        </label>

        <button type="button" className="sheet-close" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
