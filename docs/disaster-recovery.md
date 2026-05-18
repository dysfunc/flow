# Disaster Recovery

The procedure for bringing a fresh VPS to a fully running Flow stack.

## Scenario: VPS is unrecoverable, need to rebuild

### Prerequisites
- A new VPS provisioned (Debian 13+, 2GB+ RAM, 20GB+ disk)
- SSH access as a sudo-capable user (default: `debian`)
- The latest backup tarball (`flow-state-YYYYMMDD-HHMMSS.tar.gz`) from a working VPS
- A copy of `/etc/openclaw.env` from the previous VPS (or the secrets from your password manager — see `secrets.md`)

### Step 1: One-time VPS prep (not managed by ansible)
```bash
# On the new VPS
sudo apt update && sudo apt install -y curl git ansible
sudo apt install -y tailscale

# Join Tailscale (will prompt for browser auth)
sudo tailscale up

# Configure Tailscale Funnel (one-time)
sudo tailscale funnel --bg --https=443 8444
```

### Step 2: Restore secrets
```bash
# Create /etc/openclaw.env from your password manager
sudo install -m 0640 -o root -g root /dev/null /etc/openclaw.env
sudo nano /etc/openclaw.env
# Paste contents (see docs/secrets.md for required keys)
```

### Step 3: Clone ops repo
```bash
cd ~
git clone <your-private-repo-url> ops
cd ops
```

### Step 4: Run bootstrap
```bash
make bootstrap
```

This will:
- Install Docker
- Pull and run SearXNG
- Install Node.js 22 + OpenClaw
- Install systemd units for openclaw + sse-proxy
- Start everything
- Run verification

Bootstrap should take ~5 minutes on a 2GB VPS.

### Step 5: Restore workspace
```bash
# Copy the latest backup tarball to the new VPS first
scp ~/backups/flow-state-LATEST.tar.gz debian@new-vps:~/

# On the new VPS:
tar -xzf ~/flow-state-LATEST.tar.gz -C ~/

# Verify Flow's memory is back
ls ~/.openclaw/workspace/  # should show MEMORY.md, AGENTS.md, etc.

# Restart gateway to pick up restored workspace
sudo systemctl restart openclaw
```

### Step 6: Final verification
```bash
make verify
```

Should print ✓ for every check. If anything fails, see "Troubleshooting" below.

### Step 7: Update the relay
The relay needs to know the new Funnel hostname. Update the relay's routing config to point at the new `https://vps-XXXXXXXX.tail9c15a8.ts.net`.

## Scenario: Single service is broken, not the whole VPS

### OpenClaw won't start
```bash
sudo journalctl -u openclaw -n 100
# Common causes: malformed openclaw.json, missing env var, port collision
```
If config is the problem:
```bash
# There are .pre-update-* snapshots in ~/.openclaw/
ls ~/.openclaw/openclaw.json.*
# Roll back to a known-good snapshot:
sudo cp ~/.openclaw/openclaw.json.last-good ~/.openclaw/openclaw.json
sudo systemctl restart openclaw
```

### SearXNG returning 403 or no JSON
```bash
make rebuild-searxng
```
This pulls the latest image, recreates the container, and reapplies the JSON-format patch.

### OpenClaw dist patch missing after update

Symptoms: `make verify` fails on the `sender-block patch present in dist`
check, or relay UI sessions stop receiving the 4-field `Sender (untrusted
metadata)` block.

Cause: An OpenClaw npm reinstall overwrote the patched file in
`/usr/lib/node_modules/openclaw/dist/`. The `update-openclaw` playbook
re-applies patches automatically; if you ran `npm i -g openclaw` by hand
outside ansible, the patch was wiped without being re-applied.

Fix:
```bash
ansible-playbook ansible/playbooks/bootstrap.yml --tags openclaw_patches
# or, equivalently:
sudo /home/debian/.openclaw/openclaw-patches/apply.sh
```

Verify:
```bash
grep -l openclaw-patch:sender-block-v1 /usr/lib/node_modules/openclaw/dist/*.js
# Should print exactly one filename.
```

### SSE proxy crashed
```bash
sudo journalctl -u openclaw-sse-proxy -n 50
sudo systemctl restart openclaw-sse-proxy
# If still broken:
make update-sse-proxy
```

### Funnel not reachable from outside
```bash
sudo tailscale funnel status
# Should show:  https://vps-XXX.tail9c15a8.ts.net  →  http://127.0.0.1:8444
sudo tailscale funnel --bg --https=443 8444   # re-establish if missing
```

## Troubleshooting

### Bootstrap fails on "verify openclaw.env exists"
The bootstrap intentionally fails if `/etc/openclaw.env` is missing. Create it first (Step 2 above).

### Bootstrap fails on docker permission denied
The `debian` user was just added to the `docker` group but the current shell doesn't see it yet.
```bash
newgrp docker
make bootstrap
```

### `verify` says SearXNG returned 0 results
SearXNG sometimes takes 30+ seconds on first run to bootstrap its engine cache. Wait, then re-run `make verify`.

### Tailscale Funnel doesn't work after restart
The auto-flip behavior depends on `gateway.tailscale.mode = "off"` in openclaw.json (per MEMORY.md 2026-05-13 patch). Verify:
```bash
grep -A 2 tailscale ~/.openclaw/openclaw.json
# Should show: "tailscale": { "mode": "off", ... }
```

## Time-to-recovery targets

- New VPS provisioned → Flow responding: **≤ 30 min** (assuming you have the backup and secrets)
- SearXNG rebuild only: **≤ 2 min**
- OpenClaw update only: **≤ 1 min**
- Workspace restore only: **≤ 10 sec**
