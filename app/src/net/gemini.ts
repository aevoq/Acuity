// Talking to Gemini through our own /api/gemini proxy (the key stays on the
// server). Everything goes through onlineFetch, so the "Wi-Fi off" switch
// cuts it and callers get { ok: false, reason: 'offline' } to fall back on.
//
// geminiPickTool() is the online half of ADR-004: Gemini chooses which tool to
// call (function calling) and extracts its arguments. It does NOT write the
// answer; the caller runs our tool, and the tool's data-built sentence is
// what gets spoken.

import type { Intent, IntentName } from '../contracts';
import { TOOL_DECLARATIONS } from '../places/tools';
import { onlineFetch, type OnlineResult } from './online';

export const GEMINI_ENDPOINT = `${import.meta.env?.BASE_URL ?? '/'}api/gemini`;

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
}

export interface GeminiRequest {
  contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>;
  systemInstruction?: { parts: GeminiPart[] };
  tools?: unknown[];
  toolConfig?: unknown;
  generationConfig?: Record<string, unknown>;
}

export interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  error?: { message?: string } | string;
}

/** One generateContent call through the proxy. Never throws. */
export function callGemini(body: GeminiRequest, timeoutMs = 15000): Promise<OnlineResult<GeminiResponse>> {
  return onlineFetch<GeminiResponse>(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

/** Text of the first candidate, or null. */
export function geminiText(r: GeminiResponse): string | null {
  const parts = r.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('').trim();
  return text || null;
}

/** Gemini rejects OBJECT parameters with no properties, so drop empty ones. */
const functionDeclarations = TOOL_DECLARATIONS.map((d) =>
  Object.keys(d.parameters.properties).length ? d : { name: d.name, description: d.description },
);

const PICKER_PROMPT = [
  'You route a blind or low vision walker\'s question to exactly one tool of a navigation app.',
  'Always call one tool. Never answer in text: the app answers from its own map data.',
  'If the question is about crossing a road safely, call nearest or whereAmI only if it fits; never judge safety.',
  'If nothing fits, call help only when the person sounds in danger or asks for help; otherwise call repeat.',
].join(' ');

/** Map a Gemini function call to our Intent. */
function toIntent(utterance: string, call: { name: string; args?: Record<string, unknown> }): Intent {
  const name = call.name as IntentName;
  const args = call.args ?? {};
  const base = { utterance, confidence: 0.9, via: 'gemini' as const };
  switch (name) {
    case 'nearest':
    case 'navigateTo':
      return { ...base, name, query: String(args.query ?? '') };
    case 'leftRight': {
      const side = String(args.side ?? 'ahead');
      return { ...base, name: 'leftRight', side: (['left', 'right', 'ahead', 'behind'].includes(side) ? side : 'ahead') as Intent['side'] };
    }
    case 'busArrivals':
      return { ...base, name, ...(args.line ? { line: String(args.line) } : {}) };
    case 'nearestBusStop':
    case 'aroundMe':
    case 'whereAmI':
    case 'nextStep':
    case 'repeat':
    case 'help':
      return { ...base, name };
    default:
      return { ...base, name: 'unknown', confidence: 0 };
  }
}

/**
 * Ask Gemini which tool answers `utterance`. Returns the Intent, or an
 * OnlineResult failure (offline, timeout, no key) so the caller falls back to
 * the offline keyword matcher.
 */
export async function geminiPickTool(utterance: string): Promise<{ ok: true; intent: Intent } | { ok: false; message: string; offline: boolean }> {
  const r = await callGemini({
    systemInstruction: { parts: [{ text: PICKER_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: utterance }] }],
    tools: [{ functionDeclarations }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: { temperature: 0 },
  });
  if (!r.ok) return { ok: false, message: r.message, offline: r.reason === 'offline' };
  const call = r.data.candidates?.[0]?.content?.parts?.find((p) => p.functionCall)?.functionCall;
  if (!call) return { ok: false, message: 'Gemini did not pick a tool.', offline: false };
  return { ok: true, intent: toIntent(utterance, call) };
}
