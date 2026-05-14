// server.js
//
// Standalone SSE keepalive proxy for the OpenClaw gateway.
// Sits between Tailscale Funnel and the gateway, adding:
//   - periodic ": keepalive\n\n" frames on text/event-stream responses
//   - X-Accel-Buffering: no header (prevents Funnel/Nginx buffering)
//   - Content-Encoding: identity (prevents intermediate gzip buffering)
// Non-SSE responses are passed through unchanged.
//
// Config via environment variables (with defaults tuned for this host):
//   SSE_PROXY_LISTEN_HOST   default 127.0.0.1
//   SSE_PROXY_LISTEN_PORT   default 8444
//   SSE_PROXY_UPSTREAM_HOST default 127.0.0.1
//   SSE_PROXY_UPSTREAM_PORT default 8443        (the OpenClaw gateway)
//   SSE_PROXY_KEEPALIVE_MS  default 15000

import http from "node:http";
import { proxyStreamRequest, proxyUpgrade } from "./proxy-core.js";

const LISTEN_HOST   = process.env.SSE_PROXY_LISTEN_HOST   || "127.0.0.1";
const LISTEN_PORT   = Number(process.env.SSE_PROXY_LISTEN_PORT   || 8444);
const UPSTREAM_HOST = process.env.SSE_PROXY_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.SSE_PROXY_UPSTREAM_PORT || 8443);
const KEEPALIVE_MS  = Number(process.env.SSE_PROXY_KEEPALIVE_MS  || 15_000);

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`[${ts()}] ${msg}`);

const server = http.createServer(async (req, res) => {
  await proxyStreamRequest({
    req,
    res,
    upstreamHost: UPSTREAM_HOST,
    upstreamPort: UPSTREAM_PORT,
    upstreamPath: req.url,
    keepaliveMs: KEEPALIVE_MS,
    log: (m) => log(`[${req.method} ${req.url}] ${m}`),
  });
});

// HTTP/1.1 protocol upgrades (WebSocket etc.) come in on a separate event.
// The gateway uses WebSocket for the Control UI; without this handler the
// upgrade request gets dropped and clients see close code 1006.
server.on("upgrade", (req, socket, head) => {
  proxyUpgrade({
    req,
    socket,
    head,
    upstreamHost: UPSTREAM_HOST,
    upstreamPort: UPSTREAM_PORT,
    upstreamPath: req.url,
    log: (m) => log(`[upgrade ${req.url}] ${m}`),
  });
});

server.on("clientError", (err, socket) => {
  log(`clientError: ${err?.message || err}`);
  try { socket.destroy(); } catch { /* */ }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`sse-proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  log(`  upstream=http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  log(`  keepaliveMs=${KEEPALIVE_MS}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
