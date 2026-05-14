# VPS Architecture

What runs on this VPS, why, and how the pieces fit together.

## Hardware / OS

- Debian 13 (Trixie)
- Node.js 22.x (from NodeSource apt repo)
- Single VPS, identifier `vps-6c51e6bb`
- Tailscale-joined for private network + Funnel for public ingress

## Services (top-down)

```
                ┌──────────────────────────────────────────┐
   Internet ───►│  Tailscale Funnel                        │
                │  https://vps-6c51e6bb.tail9c15a8.ts.net  │
                └──────────────┬───────────────────────────┘
                               │
                               ▼ HTTPS
                ┌──────────────────────────────────────────┐
                │  openclaw-sse-proxy.service              │
                │  127.0.0.1:8444                          │
                │  Node script — adds SSE heartbeat that   │
                │  vanilla OpenClaw doesn't emit, so       │
                │  long-lived streams don't time out under │
                │  reverse-proxied connections.            │
                │  Source: ~/.openclaw/sse-proxy/          │
                └──────────────┬───────────────────────────┘
                               │
                               ▼ HTTP (loopback)
                ┌──────────────────────────────────────────┐
                │  openclaw.service                        │
                │  127.0.0.1:8443                          │
                │  OpenClaw gateway (Flow).                │
                │  Reads:                                  │
                │   - ~/.openclaw/openclaw.json (config)   │
                │   - ~/.openclaw/workspace/* (behavior)   │
                │   - /etc/openclaw.env (secrets)          │
                └──────────────┬───────────────────────────┘
                               │
                               │ web_search tool calls
                               ▼ HTTP (loopback)
                ┌──────────────────────────────────────────┐
                │  searxng (Docker container)              │
                │  127.0.0.1:8888                          │
                │  Meta-search aggregator. Zero-key, runs  │
                │  Google/Bing/etc. under the hood.        │
                │  Config: ~/searxng-data/settings.yml     │
                │  Patch: JSON output format enabled       │
                └──────────────────────────────────────────┘
```

## Why each layer exists

### Tailscale Funnel
Public reachability without exposing the VPS publicly on its own IP. Funnel hostname is auto-issued and stable per VPS. Configured once with `tailscale funnel --bg --https=443 8444`.

### SSE keepalive proxy (`:8444`)
**Why this exists:** OpenClaw's SSE endpoint emits no heartbeat. Under reverse-proxied connections (Tailscale Funnel, Cloudflare, anything that buffers), long-lived streams can hang for 100+ seconds with no data, getting killed by intermediaries.

The proxy is a small Node script that:
1. Reverse-proxies HTTP traffic to the gateway on `:8443`
2. Injects a `:keepalive` SSE comment every 15 seconds
3. Adds `X-Accel-Buffering: no` to disable nginx-style buffering

Documented in MEMORY.md as the 2026-05-13 patch. Upstream fix would obsolete this layer.

### OpenClaw gateway (`:8443`)
The actual agent runtime. Bound to loopback only — never directly exposed.

### SearXNG (`:8888`)
Backend for the `web_search` tool. Bound to loopback only. Zero API keys, runs as a Docker container with `--restart unless-stopped`. The default install doesn't enable JSON output; we patch `settings.yml` to add it.

## State on disk

```
/usr/lib/node_modules/openclaw/    ← OpenClaw install. WIPED on `npm install -g openclaw`.
/etc/systemd/system/                ← systemd units (managed by ansible)
  ├── openclaw.service
  ├── openclaw-sse-proxy.service
  ├── openclaw-sse-proxy-healthcheck.{service,timer}
  └── openclaw-sse-proxy-logrotate.{service,timer}
/etc/openclaw.env                   ← Secrets. Owned by root, mode 0640. NOT managed by ansible.
~/.openclaw/                        ← OpenClaw config + state (survives OpenClaw updates).
  ├── openclaw.json                 ← Gateway config (provider routing, plugin entries, etc.)
  ├── workspace/                    ← Flow's behavioral state (MEMORY, AGENTS, SOUL, etc.)
  ├── sse-proxy/                    ← SSE proxy script (kept here for compat with existing install.sh)
  └── plugins/                      ← Plugin install dir
~/searxng-data/                     ← SearXNG persistent config (settings.yml lives here)
~/ops/                              ← This directory. Ansible playbooks, docs, scripts.
~/backups/                          ← Tarball backups from `make backup`.
```

## Network ports

| Port | Service | Bind | Exposed |
|---|---|---|---|
| 8443 | OpenClaw gateway | 127.0.0.1 | loopback only |
| 8444 | SSE keepalive proxy | 127.0.0.1 | via Tailscale Funnel |
| 8888 | SearXNG | 127.0.0.1 | loopback only |
| (none) | Tailscale | 0.0.0.0 | managed by tailscaled |

Nothing in this stack should be bound to a public interface. The only external entry point is Tailscale Funnel.

## What's NOT on this VPS

- The MCP relay (lives on Supabase Functions)
- Cron schedules for recurring tasks (live on the relay)
- The Lovable preview app
- The Webflow team's Slack workspace (managed externally)
- Any provider API keys for HubSpot, Gmail, Google Drive, etc. — those are stored at the relay, not here

## Drift between code and reality

If the ansible playbooks ever drift from what's actually running, the source of truth is what's running. Re-snapshot the live state into the playbooks rather than re-deploying the playbooks blindly over a running stack.

Drift check: `make verify` passes when reality matches expectations. If it fails, investigate before reconciling either direction.
