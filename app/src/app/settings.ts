// Display and voice settings (the design's knobs, now a settings sheet).
// Kept in this browser only; every read and write is guarded, because storage
// can be blocked (private windows) and the app must work without it.

import { useState } from 'react';
import type { MapPalette } from '../mapview/MapCanvas';

export interface Settings {
  mapStyle: MapPalette;
  /** The design's uiZoom: 1, 1.15 or 1.3. */
  textSize: number;
  /** Speak prompts out loud with the browser's voice. */
  voice: boolean;
  speechRate: number;
  /** The person uses VoiceOver / NVDA / TalkBack: never speak over it; the live region carries everything. */
  screenReader: boolean;
  /** Walk with the browser's real GPS instead of the simulated walk. */
  realGps: boolean;
}

export const DEFAULT_SETTINGS: Settings = { mapStyle: 'standard', textSize: 1, voice: true, speechRate: 1, screenReader: false, realGps: false };
export const TEXT_SIZES = [
  { label: 'Default', value: 1 },
  { label: 'Large', value: 1.15 },
  { label: 'Extra large', value: 1.3 },
];

const KEY = 'nav.settings';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  const update = (patch: Partial<Settings>) =>
    setSettings((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: the setting still applies for this visit.
      }
      return next;
    });
  return [settings, update] as const;
}
