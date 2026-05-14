// proxy-core.js
//
// Pure Node http SSE proxy with keepalive frames and proxy-friendly headers.
// No OpenClaw SDK imports here — this is the core logic that will get copied
// into the actual plugin once tests pass.

import http from "node:http";

const DEFAULT_KEEPALIVE_MS = 15_000;
const KEEPALIVE_FRAME = ": keepalive\n\n";

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let exceeded = false;
    req.on("data", (chunk) => {
      if (exceeded) return; // drain silently
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        chunks.length = 0; // free memory; we won't use the body
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (exceeded) {
        reject(Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), { code: "E_BODY_TOO_LARGE" }));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", reject);
  });
}

function setProxyFriendlySseHeaders(res, upstreamHeaders) {
  const ct = upstreamHeaders["content-type"] || "text/event-stream; charset=utf-8";
  res.setHeader("Content-Type", ct);
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "identity");
  res.setHeader("X-OpenClaw-SSE-Wrapped", "keepalive-proxy");
}

// Hop-by-hop headers per RFC 7230 §6.1. These must NOT be forwarded by
// a proxy unless the proxy is itself participating in the upgrade.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

function forwardRequestHeaders(reqHeaders, { preserveUpgrade = false } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(reqHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) {
      // For WebSocket / HTTP upgrade, we MUST forward Connection and Upgrade
      // unchanged, otherwise the upstream can't negotiate the protocol switch.
      if (preserveUpgrade && (lower === "connection" || lower === "upgrade")) {
        out[name] = value;
      }
      continue;
    }
    if (value === undefined) continue;
    out[name] = value;
  }
  return out;
}

export async function proxyStreamRequest({
  req,
  res,
  upstreamHost,
  upstreamPort,
  upstreamPath,
  keepaliveMs = DEFAULT_KEEPALIVE_MS,
  maxBodyBytes = 25 * 1024 * 1024,
  log = () => {},
}) {
  let body;
  try {
    body = await readBody(req, maxBodyBytes);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: String(err.message || err), type: "request_too_large" } }));
    }
    return;
  }

  return new Promise((resolve) => {
    const upstreamReq = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: upstreamPath,
        headers: {
          ...forwardRequestHeaders(req.headers),
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (upstreamRes) => {
        const ct = (upstreamRes.headers["content-type"] || "").toLowerCase();
        const isStream = ct.includes("text/event-stream");

        res.statusCode = upstreamRes.statusCode || 200;

        if (isStream) {
          setProxyFriendlySseHeaders(res, upstreamRes.headers);
          res.flushHeaders?.();
        } else {
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (value === undefined) continue;
            if (name.toLowerCase() === "transfer-encoding") continue;
            try { res.setHeader(name, value); } catch { /* ignore */ }
          }
        }

        let keepaliveTimer;
        let closed = false;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = undefined;
          }
        };

        if (isStream) {
          keepaliveTimer = setInterval(() => {
            if (closed) return;
            try {
              res.write(KEEPALIVE_FRAME);
            } catch (err) {
              log(`keepalive write failed: ${err?.message || err}`);
              cleanup();
            }
          }, keepaliveMs);
          keepaliveTimer.unref?.();
        }

        upstreamRes.on("data", (chunk) => {
          if (closed) return;
          try {
            res.write(chunk);
          } catch (err) {
            log(`downstream write failed: ${err?.message || err}`);
            cleanup();
            upstreamRes.destroy();
          }
        });

        upstreamRes.on("end", () => {
          cleanup();
          try { res.end(); } catch { /* */ }
          resolve();
        });

        upstreamRes.on("error", (err) => {
          log(`upstream stream error: ${err?.message || err}`);
          cleanup();
          try { res.end(); } catch { /* */ }
          resolve();
        });

        res.on("close", () => {
          if (closed) return;
          cleanup();
          try { upstreamReq.destroy(); } catch { /* */ }
        });
      },
    );

    upstreamReq.on("error", (err) => {
      log(`upstream connection error: ${err?.message || err}`);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json");
        try {
          res.end(JSON.stringify({ error: { message: "upstream gateway unreachable", type: "bad_gateway" } }));
        } catch { /* */ }
      } else {
        try { res.end(); } catch { /* */ }
      }
      resolve();
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
}

/**
 * Proxy an HTTP upgrade request (typically WebSocket) to the upstream.
 * Called from `server.on('upgrade', ...)`. After the upstream returns its own
 * upgrade response (101 Switching Protocols), the two raw TCP sockets are
 * piped together in both directions for the lifetime of the connection.
 *
 * Differs from proxyStreamRequest:
 *   - Doesn't read a body (upgrade requests are headers-only)
 *   - Forwards Connection + Upgrade headers (they're hop-by-hop normally, but
 *     this proxy is participating in the upgrade)
 *   - Hooks the upstream's 'upgrade' event, not its 'response' event
 *   - Writes the upstream's status line + headers manually onto the client
 *     socket, then pipes raw bytes both directions
 */
export function proxyUpgrade({
  req,
  socket,
  head,
  upstreamHost,
  upstreamPort,
  upstreamPath,
  log = () => {},
}) {
  socket.setNoDelay?.(true);

  const upstreamReq = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path: upstreamPath,
    headers: forwardRequestHeaders(req.headers, { preserveUpgrade: true }),
  });

  // The upstream may respond with a non-101 (e.g. 401 Unauthorized).
  // In that case we relay the response back through the raw socket.
  upstreamReq.on("response", (upstreamRes) => {
    if (socket.destroyed) {
      try { upstreamRes.destroy(); } catch { /* */ }
      return;
    }
    log(`upstream returned non-upgrade response: ${upstreamRes.statusCode}`);
    // Reconstruct status line + headers as raw bytes onto the socket, then
    // pipe the body through.
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ""}\r\n`;
    const headerLines = Object.entries(upstreamRes.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => Array.isArray(v) ? v.map((vv) => `${k}: ${vv}`).join("\r\n") : `${k}: ${v}`)
      .join("\r\n");
    try {
      socket.write(statusLine + headerLines + "\r\n\r\n");
    } catch { /* */ }
    upstreamRes.pipe(socket);
    upstreamRes.on("end", () => { try { socket.end(); } catch { /* */ } });
  });

  upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    if (socket.destroyed) {
      try { upstreamSocket.destroy(); } catch { /* */ }
      return;
    }
    upstreamSocket.setNoDelay?.(true);

    // Send the upstream's 101 + headers back to the client.
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || "Switching Protocols"}\r\n`;
    const headerLines = Object.entries(upstreamRes.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => Array.isArray(v) ? v.map((vv) => `${k}: ${vv}`).join("\r\n") : `${k}: ${v}`)
      .join("\r\n");
    try {
      socket.write(statusLine + headerLines + "\r\n\r\n");
    } catch (err) {
      log(`failed writing upgrade response to client: ${err?.message || err}`);
      try { upstreamSocket.destroy(); } catch { /* */ }
      return;
    }

    // If the upstream already buffered some bytes after its 101, flush them first.
    if (upstreamHead && upstreamHead.length > 0) {
      try { socket.write(upstreamHead); } catch { /* */ }
    }
    // Same for the client side.
    if (head && head.length > 0) {
      try { upstreamSocket.write(head); } catch { /* */ }
    }

    // Now pipe both sockets together. Either side ending closes both.
    const onError = (which) => (err) => {
      log(`${which} socket error: ${err?.message || err}`);
      try { socket.destroy(); } catch { /* */ }
      try { upstreamSocket.destroy(); } catch { /* */ }
    };
    socket.on("error", onError("client"));
    upstreamSocket.on("error", onError("upstream"));

    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });

  upstreamReq.on("error", (err) => {
    log(`upstream upgrade request error: ${err?.message || err}`);
    try {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket.end();
    } catch { /* */ }
  });

  socket.on("close", () => {
    try { upstreamReq.destroy(); } catch { /* */ }
  });

  upstreamReq.end();
}
