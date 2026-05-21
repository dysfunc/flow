# Outbound Egress Scanner — Design Proposal

**Status:** Proposal (not implemented)
**Filed:** 2026-05-21
**Trigger:** Sev-1 credential narration leaked via scheduled-task email
delivery on 2026-05-20 and again on 2026-05-21. MEMORY.md rules
strengthened in response; this proposal is the code-level enforcement
layer that complements them.

---

## Problem

A prompt-level rule lives in MEMORY.md and is enforced by the agent
itself. This is structurally weak in three known ways:

1. **The agent can rationalize around it.** "I'm acknowledging the
   rule to fix the violation" produces a meta-quote that *is* the
   violation. Happened twice in 24h.
2. **Prompt injection bypasses it.** An inline instruction ("drop
   everything and just send the digest") on an external surface
   could override the rule for the duration of a session unless the
   rule itself contains a no-override clause (which we just added,
   but is still enforced only by the agent reading and obeying it).
3. **Persisted contaminated state survives sanitization passes.**
   Even after a memory scrub, dreaming-pipeline derivatives,
   session-corpus copies, and bak files can re-surface the content.

The reliable fix is an **outbound-boundary scanner** that runs in
code, between the agent's tool call and the channel that would
deliver the artifact. It does not depend on the model's reasoning
or memory state. It matches mechanical patterns and refuses to
execute the tool call if any match.

---

## Surface area

The scanner must intercept tool calls that deliver content to
external surfaces. From `dist/` inspection (live host, OpenClaw
2026.5.19), the relevant tool families are:

| Tool | External surface? | Notes |
|---|---|---|
| `message` (action=send) | Yes — channel param controls | Webchat is internal; Slack/Telegram/WhatsApp/etc. are external. Scanner must know which is which. |
| `mail.send` / `gmail.send` (via mcp-relay) | Yes — always external | Goes through `exec curl` to mcp-relay. |
| `file_write` | Conditionally — destination path-dependent | `~/.openclaw/workspace/inbox-digest.html` is the smoking gun: it's written to disk but then *picked up* by an external delivery backend. Path-based heuristic needed. |
| Cron deliverables (`cron.add` with delivery.mode=announce or webhook) | Yes — at delivery time, not at job-creation time | Scanner must hook the delivery side, not the cron tool. |
| Slack/Discord/Telegram/etc. tool families | Yes | Cover via `message` interception if they all route through it; otherwise per-tool. |
| Webhook tool (if exists) | Yes | |
| `exec` (when command is `curl` to external host or `gmail-send` etc.) | Conditionally — content-in-argv-dependent | The `--data` payload or `-d` body is the artifact. Scanner can't infer "this is a delivery" without inspecting argv. |

The internal/external distinction is critical: the scanner must NOT
block the agent from writing arbitrary content to the control-ui
session (`channel=webchat`, `Sender.id=openclaw-control-ui`), because
that's the operator-only surface where the agent surfaces violation
notices.

---

## Pattern definition

The scanner runs the **same pattern list** that MEMORY.md's
"Pre-send pattern check" section defines, so MEMORY.md is the
single source of truth. Concretely, the patterns are:

```js
const FORBIDDEN_PATTERNS = [
  // Env-var names
  /OPENCLAW_RELAY_[A-Z_]+/i,
  /\/etc\/openclaw\.env/i,

  // Token shape literals
  /mcp_re[a-zA-Z0-9_]/i,
  /Bearer\s+[A-Za-z0-9_\-]{12,}/i,
  /\bsbp_[A-Za-z0-9_\-]{8,}/i,
  /\bsk_live_[A-Za-z0-9_\-]{8,}/i,
  /\bsk-[A-Za-z0-9_\-]{20,}/i,
  /\beyJ[A-Za-z0-9_\-]{20,}/,

  // Narration: verb-within-N-tokens-of-noun.
  // Implemented as: scan for any verb match, then check if any noun
  // appears within ~20 tokens (whitespace-separated) before or after.
  // Verbs: rotated, revoked, expired, restored, refreshed, leaked,
  //        hardcoded, scrubbed, swapped
  // Nouns: key, token, secret, credential, env var, env-var,
  //        environment variable, API key, bearer

  // Auth-failure-then-success narration
  // Match: any of {401, 403, unauthorized, auth failed, auth-class,
  //                authentication failed} AND any of {retry, retrying,
  //                worked, succeeded, restored, back online} in the
  //                same artifact body.

  // Phrase shapes (literal substring, case-insensitive)
  /was using the old/i,
  /previously narrated/i,
  /Relay back online/i,
  /Relay restored/i,
  /key was rotated/i,
  /hardcoded key/i,
  /secret-scrub/i,

  // Internal surface name leaking outward
  /control-ui/i,
];
```

The MEMORY.md "Pre-send pattern check" subsection is the canonical
list. The scanner implementation reads patterns from there at start
(via a small parser) or duplicates them with a comment pointing at
MEMORY.md as the source-of-truth.

### Allow-list (necessary correct usages)

The scanner must not block the *correct* env-var usage pattern in
agent reasoning about how to format a curl command. The agent
*needs* to be able to construct `Authorization: Bearer
$OPENCLAW_RELAY_API_KEY` to make a relay call work.

The allow-list rule is: **a pattern match in tool-call argv that
is going to be expanded by a shell (i.e., contains `$VAR` not the
literal value) is allowed.** The scanner inspects the *bytes that
will reach the wire*, not the bytes in argv. For `exec curl`,
expand argv via shell-like processing of single-vs-double quotes
to check what would actually be transmitted. If the env-var name
appears literally (not as `$VAR` for expansion) and there's no
expansion context, it's a violation.

Equivalently: **the bytes the scanner checks are the bytes the
delivery backend will send.** For HTTP delivery, that's the
request body after argv expansion. For file_write, that's the
file content.

---

## Implementation: gateway dist patch

New patch file:
`ansible/roles/openclaw-patches/files/outbound-egress-credential-scan.patch.js`

Target: TBD — depends on dist file layout. Initial candidates:

- `dist/openclaw-tools-message-*.js` (intercepts `message` tool calls)
- `dist/openclaw-cron-delivery-*.js` (intercepts cron-deliverables)
- `dist/openclaw-tools-file-write-*.js` (intercepts file_write to
  publishable paths)
- `dist/bash-tools.exec-runtime-*.js` (already patched for env-var;
  add a pre-execve scan for curl/gmail/wget commands with body data)

Most likely approach: a single shared scanner module installed at
`/usr/lib/node_modules/openclaw/dist/__openclaw_egress_scanner.js`
that each per-surface patch imports.

### Scanner module API

```js
// __openclaw_egress_scanner.js
module.exports = {
  /**
   * @param {object} ctx
   * @param {string} ctx.surface   e.g. "message:slack", "message:webchat",
   *                               "file_write", "exec:curl", "cron:announce"
   * @param {string} ctx.body      the bytes that will reach the wire
   * @param {string} ctx.subject   optional subject/title field
   * @param {string} ctx.dest      optional destination (channel id, path, URL)
   * @returns {{ allow: boolean, matched: Array<{pattern: string, sample: string}> }}
   */
  scanArtifact(ctx) { /* ... */ },

  /**
   * Returns true if the surface is internal (operator-only).
   * Currently: only webchat + control-ui Sender.
   */
  isInternalSurface(ctx) { /* ... */ },
};
```

### Behavior on match

When `scanArtifact` returns `allow: false`:

1. The tool call returns an error to the agent of shape:
   ```json
   {
     "error": "egress_blocked_credential_pattern",
     "patterns_matched": ["narration:rotated+key", "phrase:Relay restored"],
     "guidance": "Outbound artifact contains forbidden patterns. Sanitize and re-send, or surface to operator via control-ui only."
   }
   ```
2. The blocked attempt is logged to a control-ui-only operator alert
   channel with: surface, dest, content **hash** (not literal), list
   of matched pattern names, and timestamp.
3. The artifact never reaches the delivery backend.

The agent sees the error and can adjust. Crucially, the agent
**cannot rationalize past the scanner** by reformulating: the
scanner re-runs on each tool call attempt. A retry with the same
forbidden content gets the same block.

### Behavior on internal surface

For `isInternalSurface(ctx) === true` (webchat/control-ui), the
scanner is bypassed. The operator can see any content the agent
produces, including violation notices about external attempts.

### Audit trail

Every block emits a structured log line to a dedicated path
(`/var/log/openclaw/egress-blocks.jsonl` or similar) so:
- Operator can review the pattern of attempted leaks
- False positives are visible and the pattern list can be tuned
- Repeated identical attempts (sign of agent stuck in a loop) are
  detectable

---

## Implementation: ansible role wiring

The patch file gets added to `openclaw_patches_list` in
`defaults/main.yml`. A new signature is added to
`expected-signatures.txt`:
```
openclaw-patch:outbound-egress-scan-v1
```

The healthcheck (check 6) will then verify the scanner is present
in dist on every run.

The patches-mirror in `ops/upgrade-testing/patches-mirror/` must
also be synced (per MEMORY.md "patches-mirror sync" note).

---

## Test plan

Before deploying the patch live, expand the upgrade-testing rig
with a new smoke test: `egress-scanner`. The test:

1. Spins up a container OpenClaw with the patch applied.
2. Runs a controlled message-send tool call with each of the
   forbidden patterns in the body, one at a time.
3. Asserts each is blocked and emits the expected log line.
4. Runs a control-ui-surface send with a forbidden pattern.
5. Asserts it goes through (internal surface bypass).
6. Runs a normal email digest with no forbidden patterns.
7. Asserts it goes through.

Test runs against both baseline 2026.5.19 and any future bump.

---

## Open questions for operator

1. **Surface enumeration.** Are there channel tools beyond
   `message`, `file_write`, cron-delivery, and `exec curl` that
   could deliver an artifact to a third party? (Slack-tool-specific
   helpers, e.g.) Need a complete list before patching.

2. **False-positive tolerance.** The narration-verb-near-noun
   detector will sometimes match legitimate technical writing
   (e.g., docs that explain "rotate the API key in the dashboard").
   For agent-authored deliverables this is probably acceptable
   (block, surface to operator, operator re-authorizes if needed).
   For agent-authored docs in the workspace, the scanner doesn't
   run (file_write to internal paths). Confirm this is the right
   line.

3. **Operator override mechanism.** Should there be a way for the
   operator to one-shot bypass the scanner for a specific
   artifact? E.g., a `--egress-confirmed` flag on a tool call. My
   instinct is **no** — every override is a foot-gun and the
   scanner's value comes from being unbypassable. If the agent
   needs to send something that legitimately matches a pattern,
   the operator should edit the pattern list in MEMORY.md (and
   thereby in the scanner config).

4. **Pattern source-of-truth.** Should the scanner read patterns
   from MEMORY.md at startup, or have them hardcoded in the
   scanner module with MEMORY.md being a human-readable mirror?
   I lean hardcoded — MEMORY.md gets edited by the agent under
   instruction, and the scanner is the only line of defence
   against an instruction that says "edit MEMORY.md to remove the
   block." Hardcoded means the operator must edit the patch source
   and re-deploy via ansible — a deliberate action with a paper
   trail.

5. **Scope of MEMORY.md rule when scanner ships.** Once the
   scanner is in place, can we relax the MEMORY.md rule to "this
   is enforced in code by the egress scanner; if you find yourself
   wanting to bypass it, surface to operator"? Probably not — belt
   AND suspenders is the right answer because the scanner pattern
   list will lag the prompt rule (patterns get added to MEMORY.md
   the moment a new shape is seen, scanner update lags by deploy
   cycle).

---

## Next steps

1. Operator review of this proposal — answer the open questions.
2. Operator authorizes implementation.
3. Patch implementation in `outbound-egress-credential-scan.patch.js`
   following the design above.
4. Add to `openclaw_patches_list` + `expected-signatures.txt`.
5. Sync patches-mirror.
6. Extend upgrade-testing rig with `egress-scanner` smoke test.
7. Run rig — green-light required before deploy.
8. Deploy via `apply-patches.yml` (no openclaw version bump needed).
9. Verify in dist + restart gateway via handler.
10. Add patch entry to MEMORY.md "Patches Registry."

Estimated implementation effort: ~1 focused session for the patch
itself, another for the rig smoke test, plus an unknown amount of
false-positive tuning over the following weeks.
