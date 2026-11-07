import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import { handleGemini, type GeminiEnv } from './server/gemini.ts';

/**
 * Serves POST /api/gemini from the dev and preview servers with the same
 * handler Vercel runs (server/gemini.ts). The key comes from app/.env and is
 * never sent to the browser (it has no VITE_ prefix).
 */
function geminiApi(env: GeminiEnv): Plugin {
  const middleware: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse, next) => {
    if (!req.url?.startsWith('/api/gemini')) return next();
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: { 'content-type': String(req.headers['content-type'] ?? 'application/json') },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      const response = await handleGemini(request, env);
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
  };
  return {
    name: 'gemini-api',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ''); // '' = also load non-VITE_ vars, server side only
  return {
    plugins: [react(), geminiApi({ GEMINI_API_KEY: env.GEMINI_API_KEY, GEMINI_MODEL: env.GEMINI_MODEL })],
  };
});
