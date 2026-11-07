// Connectivity: the one place the app decides "are we online?".
//
// Two inputs:
//   1. the browser's own navigator.onLine plus its online/offline events;
//   2. the on-screen demo switch ("Wi-Fi off"), which forces offline even when
//      the laptop is connected, so the demo is honest and repeatable.
//
// Offline is the default behaviour (principle 3). Every online feature must ask
// `connectivity.mode()` (or go through `onlineFetch`) and fall back when offline.

import type { Connectivity, NetworkMode } from '../contracts';

const FORCE_KEY = 'nav.forceOffline';

function readForced(): boolean {
  try {
    return localStorage.getItem(FORCE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeForced(on: boolean): void {
  try {
    localStorage.setItem(FORCE_KEY, on ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the switch still works for this session.
  }
}

export function createConnectivity(): Connectivity {
  let forced = readForced();
  const listeners = new Set<(mode: NetworkMode) => void>();

  const browserOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine);
  const mode = (): NetworkMode => (forced || !browserOnline() ? 'offline' : 'online');

  let last = mode();
  const emit = () => {
    const now = mode();
    if (now === last) return;
    last = now;
    for (const l of listeners) l(now);
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', emit);
    window.addEventListener('offline', emit);
  }

  return {
    mode,
    browserOnline,
    forceOffline(on: boolean) {
      forced = on;
      writeForced(on);
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app-wide instance. Import this, don't create your own. */
export const connectivity = createConnectivity();
