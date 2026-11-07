// Client for the local camera + voice service (app/sidecar/server.py), which
// runs Chenxi's traffic-light detector and Abdullah's voice assistant on this
// laptop. It is local, so it works offline: these calls deliberately do NOT go
// through onlineFetch.

const BASE = (import.meta.env?.VITE_SIDECAR_URL as string | undefined) ?? 'http://127.0.0.1:8765';

export interface SidecarHealth {
  mock: boolean;
  loading: boolean;
  detector: boolean;
  detectorError: string | null;
  assistant: boolean;
  assistantError: string | null;
  speech: boolean;
  voice: boolean;
  model: string | null;
}

export interface Light {
  colour: 'red' | 'amber' | 'green' | 'unknown';
  confidence: number;
  /** Normalised [x1, y1, x2, y2] in the frame. */
  box: [number, number, number, number];
}

export interface Detection {
  lights: Light[];
  objects: string[];
  brightness: number;
  ms: number;
}

export interface AskResult {
  question: string;
  answer: string;
  usedCamera: boolean;
  /** Piper's voice, as base64 WAV, when asked for. */
  audio: string | null;
}

async function call<T>(path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(t);
  }
}

/** null when the service isn't running. */
export async function sidecarHealth(): Promise<SidecarHealth | null> {
  try {
    return await call<SidecarHealth>('/health', undefined, 1500);
  } catch {
    return null;
  }
}

export const detectLights = (imageB64: string) => call<Detection>('/vision/detect', { image: imageB64 }, 6000);

export const askAssistant = (q: { question?: string; audio?: string; image?: string | null; speak?: boolean }) =>
  call<AskResult>('/assistant/ask', q, 60000);

/** Abdullah's Whisper settings, speech to text only (the main mic button). */
export const transcribeSpeech = (audio: string, hint?: string) => call<{ text: string }>('/speech/transcribe', { audio, hint }, 30000);

export interface AgentIntent {
  intent: string;
  query?: string;
  side?: 'left' | 'right' | 'ahead' | 'behind';
}
/** gemma3 (in the local service) picks one of the app's tools for a request it can't parse. */
export const agentIntent = (utterance: string) => call<AgentIntent>('/agent/intent', { utterance }, 15000);

/** Abdullah's Piper voice for any text (base64 WAV), or null when it isn't available. */
export async function piperWav(text: string): Promise<string | null> {
  try {
    return (await call<{ audio: string }>('/voice/speak', { text }, 8000)).audio;
  } catch {
    return null;
  }
}
