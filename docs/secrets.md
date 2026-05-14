# Secrets

What lives where, and how to restore if this VPS is lost.

## Principle

**No secret is stored in this repo.** Period. Anything sensitive lives in one of:

1. `/etc/openclaw.env` — env vars the OpenClaw gateway needs at startup
2. `~/ops/secrets/` — gitignored, local-only scratch space (currently just the SearXNG secret)
3. Your password manager / 1Password vault — the canonical source of truth

If this VPS dies, you need #3 to rebuild #1.

## `/etc/openclaw.env`

Owned by `root:root`, mode `0640`. Read by the systemd unit as `EnvironmentFile=`.

Required keys (current as of scaffold creation — verify against `~/.openclaw/openclaw.json` for which IDs are actually referenced):

```bash
# Gateway password (for /__openclaw__/login)
OPENCLAW_GATEWAY_PASSWORD="<random-strong-password>"

# Anthropic API key (LLM provider)
ANTHROPIC_API_KEY="sk-ant-..."

# Slack app + bot tokens (for Slack channel integration)
OPENCLAW_SLACK_APP_TOKEN="xapp-..."
OPENCLAW_SLACK_BOT_TOKEN="xoxb-..."
```

To inspect what's currently referenced without revealing values:
```bash
grep -oE '"id": "[A-Z_][A-Z0-9_]*"' ~/.openclaw/openclaw.json | sort -u
```

The values themselves are sourced from `/etc/openclaw.env` by ID. The config file never stores raw secrets.

## `~/ops/secrets/`

Local-only directory, gitignored. Currently contains:

- `searxng-secret` — 32-byte hex secret used by the SearXNG container. Auto-generated on first bootstrap. Regenerating it logs out any active SearXNG sessions (not a problem since nothing logs into SearXNG directly).

If this directory is destroyed, the next `make bootstrap` regenerates a fresh `searxng-secret`.

## Rotating a secret

### Anthropic API key
1. Update the key in your password manager
2. Edit `/etc/openclaw.env`, replace `ANTHROPIC_API_KEY`
3. `sudo systemctl restart openclaw`

### Slack tokens
Same procedure as Anthropic key.

### Gateway password
1. Pick a new strong password, store in password manager
2. Edit `/etc/openclaw.env`, replace `OPENCLAW_GATEWAY_PASSWORD`
3. `sudo systemctl restart openclaw`
4. Anyone logged into the Control UI will need to re-login

### SearXNG secret
```bash
rm ~/ops/secrets/searxng-secret
make rebuild-searxng
```

## What's NOT a secret

- Tailscale hostnames (`vps-XXXXXXXX.tail9c15a8.ts.net`) — discoverable, not sensitive
- Gateway port numbers (`8443`, `8444`, `8888`) — loopback-bound, can't be reached anyway
- The OpenClaw version (`2026.5.5`) — public

These are all fine to live in `group_vars/all.yml` and get committed.

## What's borderline

- The MCP relay URL and bearer token (currently in `MEMORY.md`)
- Provider routing table entries

The bearer token in particular is sensitive — anyone with it can call the relay as Flow. Currently it lives in MEMORY.md, which is in `~/.openclaw/workspace/`. **If this workspace is ever made public or shared**, the token in MEMORY.md needs to be redacted first.

Long-term, that token belongs in `/etc/openclaw.env` and a non-secret reference (`MCP_RELAY_TOKEN: env:MCP_RELAY_TOKEN`) in MEMORY.md. That's a future cleanup — not blocking.

## Off-VPS backup of secrets

Your password manager is the canonical source. Test the disaster recovery procedure (see `disaster-recovery.md`) periodically to confirm you can actually rebuild `/etc/openclaw.env` from your password manager alone.
