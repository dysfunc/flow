# OpenClaw dist/ patches

Local source patches applied on top of the installed OpenClaw npm package
(`/usr/lib/node_modules/openclaw/dist/`). Each patch is a unified diff
against a target file in that directory.

## Why patches and not forks

OpenClaw is updated frequently. Forking the whole tree creates merge burden
on every update. Patches let us re-apply local changes on top of upstream
without owning the entire codebase.

## Files in this directory

- `apply.sh` — locates the current target file by content signature and
  applies all `*.patch` files in order. Idempotent: detects "already
  applied" and skips. Run after every OpenClaw update.
- `expected-signatures.txt` — strings each patched file must contain after
  patching. The gateway-proxy healthcheck asserts these on every cycle so a
  silent revert (OpenClaw update wiping our changes) is caught within 15
  minutes.
- `*.patch` — individual unified diffs. One concern per patch file. Each
  patch's header documents target file, OpenClaw version range it was
  written against, what it does, and how to revert.

## Currently applied patches

| Patch | What it does | Status |
|---|---|---|
| `openai-http-sender-block.patch` | Adds a `Sender (untrusted metadata):` JSON block to the user prompt on `/v1/chat/completions` ingress, sourced from `payload.metadata.acting_user`. Makes Relay webchat turns include identity metadata equivalent to channel ingress (Slack, Mattermost, etc.). | Applied |

## Apply procedure

Manual:
```bash
sudo /home/debian/.openclaw/openclaw-patches/apply.sh
# OR (via the sudoers-allowlisted path, no password needed)
sudo -n /home/debian/.openclaw/openclaw-patches/apply.sh
```

Automatic (no human required):
1. **`openclaw-gateway-proxy.service` ExecStartPre** — runs `apply.sh` on
   every service start (boot, restart, post-update). Uses systemd `+` prefix
   to run as root despite `User=debian` for the main process.
2. **Healthcheck timer** — every 15 minutes, asserts each signature in
   `expected-signatures.txt` is present in dist/. On miss, runs `apply.sh`
   via the sudoers-allowlisted path and re-asserts. Alerts only if still
   missing after re-apply.
3. **Mtime watcher** — same healthcheck cycle compares
   `/usr/lib/node_modules/openclaw/package.json` mtime against
   `gateway-proxy/state/openclaw-package.mtime`. If newer, runs `apply.sh`
   unconditionally (catches updates between healthcheck cycles).

The script itself:
1. Resolves `openclaw` install path (env-overridable via `OPENCLAW_DIST_DIR`)
2. For each patch, finds the target file by content-signature match
   (because OpenClaw dist filenames include content hashes)
3. Checks whether the patch is already applied (idempotent)
4. Applies with `patch -p1`, with backup
5. Reports each patch's status as JSON, machine-readable

## Revert procedure

Each patch file has a `Revert:` header line listing the file(s) to restore.
The fastest revert is reinstalling OpenClaw:

```bash
sudo npm install -g openclaw  # restores stock dist/
```

Patches are then *not* re-applied automatically — `apply.sh` is only run
when desired.

## After an OpenClaw update

Nothing is required — the survival mechanisms handle it:

- **If the update finishes while the gateway-proxy is running**: the healthcheck
  timer detects the new `package.json` mtime within 15 min and re-applies.
- **If the update restarts the gateway-proxy**: ExecStartPre runs `apply.sh`
  before the new process starts serving traffic.
- **If `apply.sh` itself fails** (target file content drifted beyond the
  content-anchor's tolerance): healthcheck reports the still-missing
  signature on next cycle and stays loud (red status) until manually fixed.
  At that point:
  1. Read the new dist/ target file
  2. Update the patch helper's content-anchor or replacement string
  3. Run `apply.sh` manually to verify
  4. Bump the signature in `expected-signatures.txt` if it changed

**To verify the survival chain manually:**

```bash
# 1. Simulate a wipe
sudo cp /usr/lib/node_modules/openclaw/dist/openai-http-*.before-sender-block-patch \
  /usr/lib/node_modules/openclaw/dist/openai-http-4AOdFadL.js

# 2. Trigger healthcheck self-heal
sudo systemctl start openclaw-gateway-proxy-healthcheck.service

# 3. Verify recovery
sudo grep -c openclaw-patch:sender-block-v1 \
  /usr/lib/node_modules/openclaw/dist/openai-http-4AOdFadL.js
# Expected: 2 (the patch added two markers — helper + anchor)
```

## Adding a new patch

1. Write a Node patcher script as `<slug>.patch.js`. Must:
   - Find the target file by content-anchor (look for stable comments,
     function names, or string literals — NOT filename, which is content-hashed).
   - Be idempotent (detect already-applied via marker presence, exit clean).
   - Be fail-open (malformed input → leave file unchanged, exit with status JSON).
   - Output a single JSON line on stdout: `{"status":"applied|already-applied|skipped|failed", ...}`.
   - Add at least one grep-able marker (e.g. `openclaw-patch:<slug>-v1`).
2. Add the marker to `expected-signatures.txt`.
3. Run `sudo -n /home/debian/.openclaw/openclaw-patches/apply.sh` to install.
4. Run the healthcheck to verify the signature check passes.
5. Update the "Currently applied patches" table above.
6. Update workspace `MEMORY.md` patches registry.

The scope of the sudoers rule (`apply.sh`) automatically covers any new
patch added to this directory — no sudoers changes needed per-patch.

## Sudoers rule

`/etc/sudoers.d/openclaw-patches` allows `debian` to run `apply.sh` as root
without a password. Workspace mirror at
`/home/debian/.openclaw/gateway-proxy/sudoers.d-openclaw-patches` for
version-tracking. The live file is the canonical copy; sync after edits with:

```bash
sudo install -m 0440 -o root -g root \
  /home/debian/.openclaw/gateway-proxy/sudoers.d-openclaw-patches \
  /etc/sudoers.d/openclaw-patches
sudo visudo -c   # syntax check the whole sudoers tree
```

## Patch authoring guidelines

- One patch = one concern. Don't bundle unrelated changes.
- Patches must include enough context (3+ lines) that `patch -p1` can locate
  the change even after small surrounding edits.
- Every patch must add a stable, grep-able marker (e.g. a comment like
  `/* openclaw-patch: feature-name */`) so `expected-signatures.txt` can
  verify the patch is in place.
- Fail-open by default: if the patch's input data is malformed or absent,
  behavior must fall back to the pre-patch path. Never break the request.
- Document what fields/headers/payload shapes the patch depends on so the
  next maintainer can re-verify after upstream changes.

## ⚠️ Load-bearing security invariant

**The entire `openclaw-patches/` directory MUST be root-owned and NOT
writable by `debian`** — the sudoers rule trusts the path, not the
content, so any debian-writable file in this tree that gets executed as
root is a privilege escalation.

Required state (enforced):
```
drwxr-xr-x  root:root  /home/debian/.openclaw/openclaw-patches/
-rwxr-xr-x  root:root  apply.sh
-rw-r--r--  root:root  *.patch.js
-rw-r--r--  root:root  expected-signatures.txt
-rw-r--r--  root:root  README.md
```

Verify with:
```bash
find /home/debian/.openclaw/openclaw-patches -not -user root -o -not -group root
# (no output expected)
stat -c '%a %U:%G %n' /home/debian/.openclaw/openclaw-patches/*
```

**To add or modify a patch:** edit as root (e.g.
`sudo -e /home/debian/.openclaw/openclaw-patches/new.patch.js`). Don't
`chown` to debian and "fix it later" — the window opens a privesc.

**Why this matters:** the sudoers rule lets `debian` invoke `apply.sh`
without a password. If `debian` could also modify `apply.sh` (or any
file `apply.sh` iterates), `debian` could escalate to root with zero
friction. The protection is the file ownership, not the sudoers rule
itself. This is a classic GTFOBins-style anti-pattern; don't
reintroduce it by accident.

## History note (2026-05-16)

The original setup of this directory had everything owned by `debian:debian`
because that's where I created the files. The sudoers rule was added on top,
which inadvertently created a privesc path. Fixed same day by `chown -R
root:root`. The healthcheck doesn't validate ownership today; consider
adding an assertion if files ever get accidentally chown'd back to debian.
