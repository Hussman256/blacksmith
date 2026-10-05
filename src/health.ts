import { createServer } from "node:http";
import type { Db } from "./db.js";

/**
 * Tiny HTTP endpoint for hosts that expect a web service (Render binds PORT and
 * sleeps free instances without inbound traffic). Only started when PORT is set.
 */
export function startHealthServer(db: Db, isReady: () => boolean): void {
  const port = Number(process.env.PORT);
  if (!port) return;
  createServer((_req, res) => {
    const body = JSON.stringify({ ok: isReady(), outbox: db.outboxCounts() });
    res.writeHead(isReady() ? 200 : 503, { "content-type": "application/json" }).end(body);
  }).listen(port, () => console.log(`[health] listening on :${port}`));

  // Render routes a request to its own public URL through the proxy, which counts as traffic.
  // An external monitor (e.g. UptimeRobot on /health) is still the safer keep-awake.
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self) {
    setInterval(() => fetch(`${self}/health`).catch(() => {}), 10 * 60_000).unref();
  }
}
