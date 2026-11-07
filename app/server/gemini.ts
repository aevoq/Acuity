// The Gemini proxy: the only place the API key lives. The page calls
// POST /api/gemini; this forwards a limited request to Gemini's
// generateContent and returns the answer. The key is never sent to the
// browser (PRD stack table: "call it through a tiny server function").
//
// Runs in two places with the same code:
//   - `npm run dev` / `npm run preview`: mounted by the Vite plugin in vite.config.ts
//   - Vercel: api/gemini.ts re-exports POST
//
// Configure with app/.env (git-ignored):
//   GEMINI_API_KEY=...        # the hackathon team token (GEMINI_PROXY_KEY also works)
//   GEMINI_BASE_URL=...       # optional; default is the hackathon's Gemini proxy.
//                             # For Google directly: https://generativelanguage.googleapis.com
//   GEMINI_MODEL=...          # optional; default gemini-3.8-flash

/** The AI Agents for Accessibility hackathon's Gemini proxy (takes the team token as x-goog-api-key). */
export const DEFAULT_BASE_URL = 'https://ai4a11y.lovable.app/api/public/gemini';
export const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_BODY_BYTES = 4_000_000; // one camera frame as base64 plus the prompt
const ALLOWED_KEYS = new Set(['contents', 'systemInstruction', 'tools', 'toolConfig', 'generationConfig']);

export interface GeminiEnv {
  GEMINI_API_KEY?: string;
  GEMINI_PROXY_KEY?: string;
  GEMINI_BASE_URL?: string;
  GEMINI_MODEL?: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Handle one POST /api/gemini. Web-standard Request → Response. */
export async function handleGemini(request: Request, env: GeminiEnv): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Use POST.' });
  const key = (env.GEMINI_API_KEY || env.GEMINI_PROXY_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!key) return json(503, { error: 'GEMINI_API_KEY is not set on the server. Add it to app/.env.' });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'Request too large.' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Body must be JSON.' });
  }
  // Pass through only the generateContent fields we use; never the model or key.
  const forward: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (ALLOWED_KEYS.has(k)) forward[k] = v;
  if (!Array.isArray(forward.contents)) return json(400, { error: '`contents` is required.' });

  const base = (env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(forward),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (e) {
    return json(502, { error: `Gemini request failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
