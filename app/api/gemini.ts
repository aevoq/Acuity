// Vercel serverless function: POST /api/gemini. Set GEMINI_API_KEY (and
// optionally GEMINI_MODEL) in the Vercel project's environment variables.
import { handleGemini } from '../server/gemini.js';

export async function POST(request: Request): Promise<Response> {
  const { GEMINI_API_KEY, GEMINI_PROXY_KEY, GEMINI_BASE_URL, GEMINI_MODEL } = process.env;
  return handleGemini(request, { GEMINI_API_KEY, GEMINI_PROXY_KEY, GEMINI_BASE_URL, GEMINI_MODEL });
}
