// The single gate for anything that needs the network (Gemini, TfL live
// arrivals, building a fresh area pack). Going through here means the demo's
// "Wi-Fi off" switch really cuts every online feature, not just some of them.
//
//   const r = await onlineFetch('/api/gemini', { method: 'POST', body });
//   if (!r.ok) speak(r.reason === 'offline' ? 'That needs a connection. ...' : 'That did not work.');

import { connectivity } from './connectivity';

export type OnlineResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'offline' | 'timeout' | 'http' | 'network'; status?: number; message: string };

export interface OnlineFetchOptions extends RequestInit {
  /** Give up after this long. Default 8 s: a blind traveller should not wait in silence. */
  timeoutMs?: number;
  /** 'json' (default) or 'text'. */
  as?: 'json' | 'text';
}

export async function onlineFetch<T = unknown>(url: string, opts: OnlineFetchOptions = {}): Promise<OnlineResult<T>> {
  if (connectivity.mode() === 'offline') {
    return { ok: false, reason: 'offline', message: 'No connection, so this online feature is unavailable.' };
  }
  const { timeoutMs = 8000, as = 'json', ...init } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return { ok: false, reason: 'http', status: res.status, message: `The server answered ${res.status}.` };
    const data = (as === 'text' ? await res.text() : await res.json()) as T;
    return { ok: true, data };
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, reason: 'timeout', message: 'The online service took too long.' };
    return { ok: false, reason: 'network', message: e instanceof Error ? e.message : 'Network error.' };
  } finally {
    clearTimeout(timer);
  }
}

/** Spoken fallback when an online-only feature is asked for offline. */
export const OFFLINE_SENTENCE = 'That needs a connection, and you are offline. Everything else still works.';
