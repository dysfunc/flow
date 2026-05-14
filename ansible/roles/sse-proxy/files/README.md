# openclaw-sse-proxy

Standalone Node reverse proxy that adds SSE keepalive frames and proxy-friendly
headers to OpenClaw gateway responses. Sits between Tailscale Funnel and the
gateway so that long-running SSE streams don't get aborted by idle timers in
the downstream relay (Supabase Edge Function chat-worker, 90s `lastByteAt`
watchdog).

**Status as of 2026-05-13:** in production, Funnel pointed at `:8444`, verified
on a real Hogwarts run (job `7927faf7`, 63.5s stream, zero idle-timeout warnings)
AND verified to survive a clean `systemctl restart openclaw` (cold-restart at
16:41 UTC kept Funnel routing intact and WebSocket reconnected cleanly with
`code=1012 service restart` instead of `1006 no reason`).

---

## Why this exists

The OpenClaw gateway's OpenAI-compat SSE endpoint (`POST /v1/chat/completions`)
writes deltas directly to the socket with no batching and no keepalive frames.
During heavy model phases (multi-tool deliberation, large JSON artifact blocks),
60–120 seconds can pass with zero bytes on the wire. Two consequences:

1. **Tailscale Funnel** (and reverse proxies generally) may buffer the response
   if `X-Accel-Buffering: no` isn't set, so seemingly-continuous output looks
   like one big burst at the end.
2. **Downstream idle watchdogs** (the relay's `chunk_inactivity_timeout`,
   default 90s) abort the request when no bytes arrive for the window.

This proxy fixes both:

- Injects `: keepalive\n\n` SSE comment frames every 15s on any `text/event-stream`
  response. The relay watchdog resets on any byte from `reader.read()`, so
  these keep it alive. Comment frames are dropped by the SSE parser per spec,
  so they're invisible to the user.
- Sets `X-Accel-Buffering: no` and `Content-Encoding: identity` so Tailscale
  Funnel flushes the response unbuffered.

**It also handles HTTP/1.1 WebSocket upgrades** (`Connection: Upgrade`,
`Upgrade: websocket`). The gateway's Control UI / webchat connects over
WebSocket; without this support clients see `close code 1006 (abnormal
closure)`. The proxy hooks Node's `'upgrade'` event, preserves the
upgrade-handshake headers (which are normally hop-by-hop), and pipes
the raw TCP sockets bidirectionally after the 101 Switching Protocols
response.

Non-SSE, non-upgrade responses (JSON errors, healthcheck pings, the
static web UI HTML, etc.) pass through unchanged with all original
headers preserved.

Full diagnosis history in `~/.openclaw/workspace/patches/2026-05-13-sse-streaming-gateway-fix.md`.

---

## Architecture

```
Public client (web UI, relay, OpenAI SDK)
     │
     │ HTTPS  (TLS to vps-6c51e6bb.tail9c15a8.ts.net:443)
     ▼
Tailscale Funnel  (terminates TLS)
     │
     │ HTTP
     ▼
openclaw-sse-proxy  127.0.0.1:8444   ← THIS SERVICE
     │  • injects ': keepalive\n\n' frames on text/event-stream
     │  • adds X-Accel-Buffering: no + Content-Encoding: identity
     │  • forwards WebSocket upgrades (preserves Connection/Upgrade)
     │  • passes everything else through unchanged
     ▼
OpenClaw gateway  127.0.0.1:8443
     (gateway.tailscale.mode = "off"
      so it does NOT auto-manage Funnel)
     (gateway.trustedProxies = ["127.0.0.1/32", "::1/128"]
      so it trusts the proxy's forwarded client identity)
```

---

## Files

| Path | Purpose |
|---|---|
| `~/.openclaw/sse-proxy/proxy-core.js` | Pure-Node SSE-aware proxy primitive (no dependencies) |
| `~/.openclaw/sse-proxy/server.js` | Entry script, reads env vars, listens on `127.0.0.1:8444` |
| `~/.openclaw/sse-proxy/openclaw-sse-proxy.service` | Main proxy systemd unit |
| `~/.openclaw/sse-proxy/openclaw-sse-proxy-healthcheck.service` | Healthcheck oneshot, invoked by timer |
| `~/.openclaw/sse-proxy/openclaw-sse-proxy-healthcheck.timer` | Fires every 15 minutes |
| `~/.openclaw/sse-proxy/openclaw-sse-proxy-logrotate.service` | Log truncator oneshot |
| `~/.openclaw/sse-proxy/openclaw-sse-proxy-logrotate.timer` | Fires weekly (Monday 00:00 UTC) |
| `~/.openclaw/sse-proxy/healthcheck.sh` | Self-healing healthcheck script (verifies service + Funnel state, repairs drift) |
| `~/.openclaw/sse-proxy/healthcheck-wrapper.sh` | Thin wrapper invoked by the healthcheck unit; always logs a timestamped heartbeat line |
| `~/.openclaw/sse-proxy/install.sh` | Idempotent installer — re-run after any reinstall or upgrade |
| `~/.openclaw/sse-proxy/healthcheck.log` | Append-only log of healthcheck runs (rotated weekly to last 1000 lines) |
| `~/.openclaw/sse-proxy/README.md` | This file |
| `/etc/systemd/system/openclaw-sse-proxy*.service` and `*.timer` | Installed systemd units (root-owned) |
| `~/.openclaw/workspace/patches/2026-05-13-sse-streaming-gateway-fix.md` | Diagnosis + history |
| `~/.openclaw/workspace/MEMORY.md` (Patches Registry) | Tracks this as a "Mitigated (local)" patch |

---

## Config (env vars, set in the systemd unit)

| Variable                  | Default          | Notes |
| ------------------------- | ---------------- | ----- |
| `SSE_PROXY_LISTEN_HOST`   | `127.0.0.1`      | Loopback only — Funnel terminates TLS in front of us |
| `SSE_PROXY_LISTEN_PORT`   | `8444`           | Funnel upstream points here |
| `SSE_PROXY_UPSTREAM_HOST` | `127.0.0.1`      | The OpenClaw gateway |
| `SSE_PROXY_UPSTREAM_PORT` | `8443`           | OpenClaw gateway HTTP port (per `~/.openclaw/openclaw.json` `gateway.port`) |
| `SSE_PROXY_KEEPALIVE_MS`  | `15000`          | Well under the relay's 90s watchdog |

---

## Operations

### Install or reinstall (idempotent)

```bash
bash ~/.openclaw/sse-proxy/install.sh
```

The installer:
1. Copies the systemd unit to `/etc/systemd/system/`
2. Reloads systemd
3. Enables + (re)starts the service
4. Verifies it bound `:8444`
5. Verifies Tailscale Funnel is on and pointing at `:8444`

Run this **after any OpenClaw upgrade or reinstall** — see "OpenClaw upgrade
procedure" below.

### Status

```bash
sudo systemctl status openclaw-sse-proxy --no-pager
ss -tlnp | grep ":8444 "
tailscale funnel status
```

### Logs

```bash
sudo journalctl -u openclaw-sse-proxy -f
```

The proxy logs only on startup and on errors. **Silence is success** — a healthy
busy run produces zero log lines beyond the startup banner.

### Restart

```bash
sudo systemctl restart openclaw-sse-proxy
```

If you have a manual `node server.js` instance running (e.g. from a test), kill
it first or systemd will retry-loop on `EADDRINUSE`.

### Healthcheck (manual)

```bash
bash ~/.openclaw/sse-proxy/healthcheck.sh
```

This is non-destructive by default — it reports drift but doesn't fix it.
Add `--repair` to auto-fix:

```bash
bash ~/.openclaw/sse-proxy/healthcheck.sh --repair
```

The healthcheck verifies:
- Service is `active` and bound to `:8444`
- Gateway is listening on the expected port (from `openclaw.json`)
- Tailscale Funnel is publicly on and routes `/` → `127.0.0.1:8444`

### Automatic healthcheck (already configured)

A systemd timer runs `healthcheck.sh --repair --quiet` every 15 minutes:

```bash
systemctl list-timers openclaw-sse-proxy-\* --all
```

Each run appends one line to `~/.openclaw/sse-proxy/healthcheck.log`:

```
[2026-05-13T14:07:17Z] healthcheck exit=0
```

The log is rotated weekly (Monday 00:00 UTC) to the last 1000 lines.
To tail it in real time:

```bash
tail -F ~/.openclaw/sse-proxy/healthcheck.log
```

Any non-zero exit code means at least one check failed AND the auto-repair
didn't fully recover — worth investigating with the manual healthcheck.

### Restore Funnel routing (if it drifts)

This is the easy one to mess up. **The correct command is `funnel`, not `serve`:**

```bash
# ✅ correct — public exposure
sudo tailscale funnel --bg 8444

# ❌ wrong — disables public exposure (we hit this trap during cutover)
sudo tailscale serve --bg --https=443 http://127.0.0.1:8444
```

To verify Funnel is publicly on, look for `(Funnel on)`:

```
$ tailscale funnel status
# Funnel on:
#     - https://vps-6c51e6bb.tail9c15a8.ts.net
https://vps-6c51e6bb.tail9c15a8.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:8444
```

If it shows `(tailnet only)` instead of `(Funnel on)`, the public route is
broken — re-run `sudo tailscale funnel --bg 8444`.

### Rollback (point Funnel back at the gateway directly)

Use the bundled helper for safety — manual `tailscale serve` vs `tailscale
funnel` is the single biggest footgun in this stack:

```bash
bash ~/.openclaw/sse-proxy/fix-funnel.sh --bypass
```

The `--bypass` flag points Funnel at `127.0.0.1:8443` (gateway direct). The
proxy keeps running on `:8444` but receives no traffic. To restore the
normal proxy path, run `fix-funnel.sh` without arguments.

If you need the raw commands (debugging, scripting outside this dir):

```bash
sudo tailscale funnel --bg 8443   # ✅ keeps Funnel publicly on
sudo tailscale serve --bg ...     # ❌ DISABLES Funnel (tailnet-only)
```

**Always use `funnel`, never `serve`,** for the public path. They look
similar but do opposite things. Use `fix-funnel.sh` to avoid the trap.

---

## OpenClaw upgrade procedure

OpenClaw upgrades touch:
- `/usr/lib/node_modules/openclaw/` (the installed package)
- `/usr/bin/openclaw` (the binary symlink)
- Possibly `~/.openclaw/openclaw.json` (config schema migrations)

None of these paths overlap with the proxy:
- `~/.openclaw/sse-proxy/` (proxy code + unit source)
- `/etc/systemd/system/openclaw-sse-proxy.service` (installed unit)

**So the proxy itself usually survives OpenClaw upgrades unchanged.** What can
break:

1. **`gateway.port` changes in `openclaw.json`.** If OpenClaw changes its
   default HTTP port from `8443`, the proxy's `SSE_PROXY_UPSTREAM_PORT` env var
   no longer matches. Fix: update the env in the unit file, `daemon-reload`,
   restart.

2. **`gateway.tailscale.mode` config could be reset to `"funnel"` by an
   upgrade migration or a manual `openclaw configure` run.** If that happens,
   the gateway will start auto-running `sudo tailscale funnel --bg --yes
   <gateway.port>` on every restart, flipping Funnel away from the proxy.
   Symptom: heavy SSE responses start failing again, login may break if
   `trustedProxies` is also lost. Fix: re-set `gateway.tailscale.mode =
   "off"` and `gateway.trustedProxies = ["127.0.0.1/32", "::1/128"]` in
   `openclaw.json` (these are protected config paths, must be edited
   directly, not via the `gateway config.patch` tool).

3. **The proxy port `:8444` could be claimed by something else** OpenClaw
   adds in a future version. Easy to detect (`ss -tlnp | grep :8444`),
   easy to fix (move proxy to another port, update Funnel + unit).

### Upgrade checklist

After every OpenClaw upgrade (`sudo openclaw update` or equivalent):

```bash
# 1. Confirm gateway still listens on :8443
ss -tlnp | grep ":8443"
cat ~/.openclaw/openclaw.json | python3 -c 'import sys,json; print(json.load(sys.stdin).get("gateway",{}).get("port"))'

# 2. Re-run the proxy installer (idempotent, safe to run every time)
bash ~/.openclaw/sse-proxy/install.sh

# 3. Verify end-to-end
bash ~/.openclaw/sse-proxy/healthcheck.sh
```

If the healthcheck reports any drift, add `--repair`:

```bash
bash ~/.openclaw/sse-proxy/healthcheck.sh --repair
```

### Reinstall (workspace wipe / fresh box)

If you're rebuilding the whole environment:

1. Restore the workspace (where this README and the patch live)
2. The proxy files at `~/.openclaw/sse-proxy/` need to exist — copy them from
   backup or re-derive from `~/.openclaw/workspace/scratch/sse-keepalive-proxy-test/`
   (where the original test harness + `proxy-core.js` came from)
3. Run `bash ~/.openclaw/sse-proxy/install.sh`
4. Run `sudo tailscale funnel --bg 8444`

---

## Verification

### Quick smoke test

```bash
curl -is http://127.0.0.1:8444/healthz --max-time 3
```

Should return `HTTP/1.1 200 OK` from the gateway, headers passed through.

### SSE wrapper verification

A real SSE response will include these proxy-injected headers:

```
X-Accel-Buffering: no
X-OpenClaw-SSE-Wrapped: keepalive-proxy
Content-Encoding: identity
```

Look for `X-OpenClaw-SSE-Wrapped` to confirm the response went through the proxy.

### Heavy-load verification

Run a heavy SSE prompt (multi-artifact, long generation). On the relay side,
the chat-worker log should show:

- `first chunk received` within ~500ms of the request
- `stream complete: bytes=… contentLen=… toolCalls=…` after the run
- **Zero** `stream idle for` warnings
- **Zero** `chunk_inactivity_timeout` lines
- **Zero** `non-SSE line ignored` lines

This is the canonical "proxy is working" signal — verified once with Hogwarts
job `7927faf7` (63.5s stream, 46,602 wire bytes, clean completion).

---

## Test suite (development / regression)

The original test harness lives at `~/.openclaw/workspace/scratch/sse-keepalive-proxy-test/`:

```bash
cd ~/.openclaw/workspace/scratch/sse-keepalive-proxy-test
./run-tests.sh
```

Expected: 21 passed, 0 failed. Tests cover headers, keepalive frames, hop-by-hop
header stripping, error pass-through, client-disconnect cleanup, and timer
cleanup between requests.

If you modify `proxy-core.js`, copy the modified version into `~/.openclaw/sse-proxy/`
and re-run the test suite first.

---

## Future work

- **Upstream OpenClaw fix:** add SSE keepalive + `X-Accel-Buffering: no` to
  `dist/openai-http-*.js` and `dist/http-common-*.js` in the OpenClaw repo.
  Once shipped and our gateway is on that version, this proxy can be retired.
  See `patches/2026-05-13-sse-streaming-gateway-fix.md` for the suggested diff.
- **Resolved:** the "Funnel state didn't persist" mystery from the morning was
  actually OpenClaw auto-running `tailscale funnel --bg --yes 8443` on every
  gateway restart when `gateway.tailscale.mode = "funnel"`. Fixed by setting
  `mode = "off"`. The gateway no longer touches Funnel at all.
