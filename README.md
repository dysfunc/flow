# Flow VPS Operations

Ansible playbooks and operational scripts for the VPS that hosts the OpenClaw gateway (Flow). Designed for:

1. **Disaster recovery** — bring a fresh VPS to a known-good state in one command
2. **Routine updates** — OpenClaw, SearXNG, system packages
3. **State documentation** — `docs/architecture.md` describes what's running and why

## Why this lives at `~/ops/`

This directory sits outside:
- `/usr/lib/node_modules/openclaw/` (wiped on every OpenClaw npm reinstall)
- `~/.openclaw/` (sometimes touched by OpenClaw itself; not a safe long-term home for ops code)
- `~/.openclaw/workspace/` (Flow's working directory — injected into prompts; ops scripts don't belong there)

`~/ops/` is operator-owned. Nothing in this tree is read by Flow at runtime.

## Layout

```
ops/
├── README.md                    you are here
├── Makefile                     convenience wrappers around ansible commands
├── docs/
│   ├── architecture.md          what runs on this VPS and how it fits together
│   ├── disaster-recovery.md     fresh-VPS → working-Flow procedure
│   └── secrets.md               what secrets exist, where they live, how to rotate
├── ansible/
│   ├── ansible.cfg
│   ├── inventory.yml            single VPS today, room for staging later
│   ├── group_vars/all.yml       non-secret config (ports, paths, versions)
│   ├── playbooks/
│   │   ├── bootstrap.yml        fresh VPS → fully running stack
│   │   ├── update-openclaw.yml  pull latest OpenClaw, restart, verify
│   │   ├── rebuild-searxng.yml  pull latest image, recreate container, verify
│   │   ├── update-sse-proxy.yml reinstall SSE keepalive proxy from versioned files
│   │   ├── backup.yml           tar up workspace + config to ~/backups/
│   │   └── verify.yml           health-check the entire stack
│   └── roles/
│       ├── docker/              install Docker, add debian to group
│       ├── searxng/             container + settings.yml patches
│       ├── openclaw/            npm install + systemd unit + env file
│       ├── sse-proxy/           SSE keepalive proxy + healthcheck/logrotate timers
│       └── workspace/           restore MEMORY.md, AGENTS.md, skills/, patches/
└── scripts/
    └── backup-state.sh          quick manual backup (called by backup.yml too)
```

## Quick start

Everything runs against `localhost` (this VPS), so no SSH config needed.

```bash
# install ansible first time
sudo apt install -y ansible

# preview what bootstrap would do (no changes)
make plan

# run bootstrap (idempotent — safe to re-run)
make bootstrap

# update only OpenClaw
make update-openclaw

# rebuild SearXNG container with the latest image
make rebuild-searxng

# verify the whole stack is healthy
make verify

# manual backup before risky changes
make backup
```

## Where this should live long-term

Right now this is a local directory. The next step is pushing it to a private git repo (GitHub, Codeberg, wherever) so:

- VPS death doesn't destroy the playbooks
- Changes have a history
- A second machine can clone-and-run for staging

**Do not commit `secrets/` or `.env` files.** The `.gitignore` blocks the obvious ones. Secrets live in `/etc/openclaw.env` (already on the VPS) and are referenced by playbooks, never copied into the repo.

See `docs/secrets.md` for the secret inventory.

## What this scaffold deliberately does NOT do

- **It doesn't manage Tailscale.** Tailscale is bootstrapped manually (one-time `tailscale up`) and Funnel is configured once. Re-running ansible doesn't touch Tailscale state.
- **It doesn't manage DNS.** The Tailscale Funnel hostname is auto-assigned.
- **It doesn't manage Slack, the relay, or any external SaaS.** Those are external to the VPS lifecycle.
- **It doesn't auto-update on a schedule.** All updates are manual / operator-initiated. Cron is on the relay, not on the VPS.

## Current VPS state (as of scaffold creation)

See `docs/architecture.md` for the canonical inventory. Quick summary:

- Debian 13 (Trixie), Node 22.22.2
- OpenClaw 2026.5.5 from npm, running as systemd `openclaw.service`
- Docker 26.1.5 with SearXNG container on `127.0.0.1:8888`
- SSE keepalive proxy on `:8444` (workaround for gateway SSE without heartbeat — see MEMORY.md 2026-05-13 patch)
- Tailscale Funnel exposing `https://vps-6c51e6bb.tail9c15a8.ts.net` → `:8444`
