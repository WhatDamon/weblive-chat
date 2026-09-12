import type { Hono } from "hono";
import { buildApp } from "./app";

/** Lazy singleton: storage connects on first request, never at import time. */
let state: { app: Hono } | null = null;
const getApp = async () => {
 state ??= { app: (await buildApp()).app };
 return state.app;
};

// No top-level await: the bundle may be transpiled to CJS, which breaks it.
if (import.meta.main) {
 void buildApp().then(({ cfg, app }) => {
  const server = Bun.serve({
   port: cfg.port,
   fetch: app.fetch,
   // Bun rejects idleTimeout > 255; SSE is kept alive by the heartbeat, this is a backstop.
   idleTimeout: 255,
  });
  console.log(`WebLive Chat listening on http://localhost:${server.port}/`);
 });
}

/**
 * Vercel entry; the export shape must stay an object with `fetch`. A bare function export is
 * called as a legacy (req, res) handler, so the response never flushes.
 */
export default {
 async fetch(request: Request): Promise<Response> {
  const app = await getApp();
  return app.fetch(request);
 },
};
