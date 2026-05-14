# First-Time Setup

Run this once on a VPS where the ops repo has just been cloned (or first-time on the existing VPS to bring it under management).

## Existing VPS (this one)

The VPS is already running. We just need to install ansible and validate the playbooks match reality.

### 1. Install ansible

```bash
sudo apt update && sudo apt install -y ansible
```

### 2. Install required collections

```bash
cd ~/ops
ansible-galaxy collection install -r ansible/requirements.yml
```

### 3. Dry-run the bootstrap (no changes — confirms playbooks match reality)

```bash
make plan
```

Expected output: a list of tasks, all reporting "ok" or skipped — no "changed" tasks. If any task wants to make a change, that means the playbook drifts from the live VPS state. Investigate before letting it run.

### 4. Run the first verification

```bash
make verify
```

Expected output: all ✓ marks. This confirms the playbook's understanding of "healthy" matches what's actually running.

### 5. Take a baseline backup

```bash
make backup
```

Writes to `~/backups/flow-state-YYYYMMDDTHHMMSSZ.tar.gz`. This is your disaster-recovery seed.

### 6. Initialize git (if not already done)

```bash
cd ~/ops
git init
git add -A
git status   # review what's being added — confirm secrets/ is NOT listed
git commit -m "Initial ops scaffold"
```

### 7. Push to a private remote

Create a private repo on your git host of choice (GitHub, Codeberg, GitLab). Then:

```bash
cd ~/ops
git remote add origin <your-private-repo-url>
git push -u origin main
```

**Critical:** verify the repo is private before pushing. The repo contains:
- VPS hostname (`vps-6c51e6bb`)
- Service configuration
- Internal port numbers
- References to `/etc/openclaw.env` (the file itself, NOT its contents)

None of these are catastrophic if leaked, but treating the repo as private is the right hygiene.

## Fresh VPS

See `docs/disaster-recovery.md` for the full procedure when this VPS dies or a new one is being stood up.

## Verifying the setup is working

After all the steps above, you should be able to:

```bash
# from anywhere on the VPS
make verify   # all ✓
make plan     # all ok, no changes
make backup   # writes a tarball
```

If any of those misbehaves, the scaffold has a bug. Fix it before depending on it.
