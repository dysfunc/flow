// server.js
//
// gateway-proxy — successor to sse-proxy.
//
// Sits between Tailscale Funnel and the OpenClaw gateway. Original job
// (SSE keepalive + proxy-friendly headers + WebSocket upgrade forwarding)
// is unchanged. New job: caller-supplied identity normalization (see
// identity.js).
//
// Env vars (with sse-proxy fallback for one release so a botched deploy
// doesn't lock us out):
//   GATEWAY_PROXY_LISTEN_HOST   (fallback SSE_PROXY_LISTEN_HOST)   default 127.0.0.1
//   GATEWAY_PROXY_LISTEN_PORT   (fallback SSE_PROXY_LISTEN_PORT)   default 8444
//   GATEWAY_PROXY_UPSTREAM_HOST (fallback SSE_PROXY_UPSTREAM_HOST) default 127.0.0.1
//   GATEWAY_PROXY_UPSTREAM_PORT (fallback SSE_PROXY_UPSTREAM_PORT) default 8443
//   GATEWAY_PROXY_KEEPALIVE_MS  (fallback SSE_PROXY_KEEPALIVE_MS)  default 15000
//   GATEWAY_PROXY_ACTING_USER_MODE                                 default "off"
//   GATEWAY_PROXY_ALLOWED_EMAIL_DOMAINS                            default ""
//   GATEWAY_PROXY_ENFORCE_PATHS                                    default "/chat"

import http from "node:http";
import { proxyStreamRequest, proxyUpgrade } from "./proxy-core.js";
import { evaluateIdentity, loadIdentityConfig } from "./identity.js";

const envFirst = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
};

const LISTEN_HOST   = envFirst("GATEWAY_PROXY_LISTEN_HOST",   "SSE_PROXY_LISTEN_HOST")   || "127.0.0.1";
const LISTEN_PORT   = Number(envFirst("GATEWAY_PROXY_LISTEN_PORT",   "SSE_PROXY_LISTEN_PORT")   || 8444);
const UPSTREAM_HOST = envFirst("GATEWAY_PROXY_UPSTREAM_HOST", "SSE_PROXY_UPSTREAM_HOST") || "127.0.0.1";
const UPSTREAM_PORT = Number(envFirst("GATEWAY_PROXY_UPSTREAM_PORT", "SSE_PROXY_UPSTREAM_PORT") || 8443);
const KEEPALIVE_MS  = Number(envFirst("GATEWAY_PROXY_KEEPALIVE_MS",  "SSE_PROXY_KEEPALIVE_MS")  || 15_000);

const identityConfig = loadIdentityConfig(process.env);

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`[${ts()}] ${msg}`);

function respondJson(res, statusCode, body) {
  if (res.headersSent) {
    try { res.end(); } catch { /* */ }
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  try {
    res.end(JSON.stringify(body));
  } catch {
    try { res.end(); } catch { /* */ }
  }
}

function logAudit(prefix, audit) {
  // Compact one-line audit log; emails are user-routing data, log at info.
  const parts = [
    `mode=${audit.mode}`,
    `req_id=${audit.requestId}`,
    `claim=${audit.claimPresent ? "yes" : "no"}`,
  ];
  if (audit.userId) parts.push(`uid=${audit.userId}`);
  if (audit.email)  parts.push(`email=${audit.email}`);
  if (audit.reason) parts.push(`reason="${audit.reason}"`);
  log(`${prefix} ${parts.join(" ")}`);
}

const server = http.createServer(async (req, res) => {
  const reqLogPrefix = `[${req.method} ${req.url}]`;

  const decision = evaluateIdentity({
    reqHeaders: req.headers,
    reqPath: req.url,
    config: identityConfig,
  });

  logAudit(reqLogPrefix, decision.audit);

  if (decision.action === "reject") {
    respondJson(res, decision.rejection.statusCode, decision.rejection.body);
    return;
  }

  // Mutate req.headers so proxy-core's forwardRequestHeaders picks up the
  // normalized claim header (and the stripped raw headers).
  req.headers = decision.mutatedHeaders;

  await proxyStreamRequest({
    req,
    res,
    upstreamHost: UPSTREAM_HOST,
    upstreamPort: UPSTREAM_PORT,
    upstreamPath: req.url,
    keepaliveMs: KEEPALIVE_MS,
    log: (m) => log(`${reqLogPrefix} ${m}`),
  });
});

// HTTP/1.1 protocol upgrades (WebSocket). Identity is stamped on the upgrade
// request — chat-worker opens one short-lived WS per turn, so per-connection
// identity is correct.
server.on("upgrade", (req, socket, head) => {
  const reqLogPrefix = `[upgrade ${req.url}]`;

  const decision = evaluateIdentity({
    reqHeaders: req.headers,
    reqPath: req.url,
    config: identityConfig,
  });

  logAudit(reqLogPrefix, decision.audit);

  if (decision.action === "reject") {
    // For upgrade requests, raw socket. Write a minimal HTTP response and close.
    try {
      const body = JSON.stringify(decision.rejection.body);
      socket.write(
        `HTTP/1.1 ${decision.rejection.statusCode} Forbidden\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n` +
        body
      );
      socket.end();
    } catch {
      try { socket.destroy(); } catch { /* */ }
    }
    return;
  }

  req.headers = decision.mutatedHeaders;

  proxyUpgrade({
    req,
    socket,
    head,
    upstreamHost: UPSTREAM_HOST,
    upstreamPort: UPSTREAM_PORT,
    upstreamPath: req.url,
    log: (m) => log(`${reqLogPrefix} ${m}`),
  });
});

server.on("clientError", (err, socket) => {
  log(`clientError: ${err?.message || err}`);
  try { socket.destroy(); } catch { /* */ }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`gateway-proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  log(`  upstream=http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  log(`  keepaliveMs=${KEEPALIVE_MS}`);
  log(`  identity.mode=${identityConfig.mode}`);
  log(`  identity.allowedDomains=${identityConfig.allowedDomains.join(",") || "<none>"}`);
  log(`  identity.enforcePaths=${identityConfig.enforcedPaths.join(",")}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
