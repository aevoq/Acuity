// Vercel serverless function: POST /api/gemini. Set GEMINI_API_KEY (and
// optionally GEMINI_MODEL) in the Vercel project's environment variables.
import { handleGemini } from '../server/gemini.js';

export async function POST(request: Request): Promise<Response> {
  return handleGemini(request, { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_MODEL: process.env.GEMINI_MODEL });
}
