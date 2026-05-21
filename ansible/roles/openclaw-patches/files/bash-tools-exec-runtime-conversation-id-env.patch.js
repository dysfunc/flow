#!/usr/bin/env node
/**
 * bash-tools-exec-runtime-conversation-id-env.patch.js
 *
 * Injects OPENCLAW_CONVERSATION_ID into the env of every child process
 * spawned by the exec tool. The value comes from the global, symbol-keyed
 * AsyncLocalStorage that openai-http-conversation-id-ingress.patch.js
 * populates on each /v1/chat/completions request.
 *
 * Why this exists (read this before reverting):
 *   The relay's MCP backend is not consumed via a native MCP transport on
 *   this OpenClaw instance — it's consumed via `exec curl` invocations
 *   that the agent builds inside its tool calls. Patches that wrap
 *   StreamableHTTPClientTransport / SSEClientTransport (Patch 3 v1/v2) do
 *   not intercept these calls because the catalog never resolves a
 *   transport for the relay URL. The only deterministic injection point
 *   on the actual relay-call path is the env of the spawned shell.
 *
 *   With OPENCLAW_CONVERSATION_ID in the env, MEMORY.md instructs Flow to
 *   include it in every relay call's acting_user as
 *   "conversation_id": "${OPENCLAW_CONVERSATION_ID:-}". The relay reads
 *   that path server-side (confirmed by the relay team) so no further
 *   gateway-side header injection is required.
 *
 * Target: /usr/lib/node_modules/openclaw/dist/bash-tools.exec-runtime-*.js
 * Marker: openclaw-patch:exec-runtime-conv-id-env-v1
 *
 * Companion patches:
 *   - openai-http-conversation-id-ingress.patch.js  (the producer)
 *
 * Behavior:
 *   - Resolves Symbol.for("openclaw.patch.conversationIdAls") on globalThis
 *     and reads .conversationId from the active store, if any.
 *   - Adds the value to shellRuntimeEnv on every exec spawn. If ALS is
 *     empty or has no conv-id, no env var is added (no empty string).
 *   - Idempotent (skips on re-apply by marker).
 *
 * Revert: npm install -g openclaw   (restores stock dist/)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = 'openclaw-patch:exec-runtime-conv-id-env-v1';

const ANCHOR =
  'const shellRuntimeEnv = {\n' +
  '\t\t...opts.env,\n' +
  '\t\tOPENCLAW_SHELL: "exec"\n' +
  '\t};';

const REPLACEMENT =
  'const shellRuntimeEnv = (() => {\n' +
  '\t\t/* ' + MARKER + ' */\n' +
  '\t\tconst base = { ...opts.env, OPENCLAW_SHELL: "exec" };\n' +
  '\t\ttry {\n' +
  '\t\t\tconst als = globalThis[Symbol.for("openclaw.patch.conversationIdAls")];\n' +
  '\t\t\tif (als && typeof als.getStore === "function") {\n' +
  '\t\t\t\tconst store = als.getStore();\n' +
  '\t\t\t\tconst v = store && typeof store === "object" ? store.conversationId : undefined;\n' +
  '\t\t\t\tif (typeof v === "string" && v.length > 0 && v.length <= 128) {\n' +
  '\t\t\t\t\tbase.OPENCLAW_CONVERSATION_ID = v;\n' +
  '\t\t\t\t}\n' +
  '\t\t\t}\n' +
  '\t\t} catch (_e) {}\n' +
  '\t\treturn base;\n' +
  '\t})();';

function fail(msg) {
  process.stdout.write(JSON.stringify({ status: 'failed', error: msg }) + '\n');
  process.exit(0);
}
function ok(status, extra) {
  process.stdout.write(JSON.stringify(Object.assign({ status }, extra || {})) + '\n');
  process.exit(0);
}

(function main() {
  const distDir = process.env.OPENCLAW_DIST_DIR || '/usr/lib/node_modules/openclaw/dist';
  let target;
  try {
    const matches = fs.readdirSync(distDir).filter(f => /^bash-tools\.exec-runtime-.*\.js$/.test(f));
    if (matches.length === 0) fail('no bash-tools.exec-runtime-*.js found in ' + distDir);
    if (matches.length > 1) fail('multiple bash-tools.exec-runtime-*.js found: ' + matches.join(', '));
    target = path.join(distDir, matches[0]);
  } catch (e) {
    fail('cannot read distDir ' + distDir + ': ' + e.message);
  }

  let src = fs.readFileSync(target, 'utf8');

  if (src.indexOf(MARKER) !== -1) {
    ok('already-applied', { file: target });
  }

  if (src.indexOf(ANCHOR) === -1) {
    fail('exec-runtime shellRuntimeEnv anchor not found — dist layout may have changed');
  }
  // Anchor must be unique so we don't accidentally clobber a similar block.
  if (src.indexOf(ANCHOR) !== src.lastIndexOf(ANCHOR)) {
    fail('anchor not unique — refusing to patch');
  }

  src = src.replace(ANCHOR, REPLACEMENT);

  if (src.indexOf(MARKER) === -1) fail('post-patch marker missing');
  if (src.indexOf('OPENCLAW_CONVERSATION_ID') === -1) fail('post-patch env var missing');

  const tmp = target + '.patch-tmp';
  fs.writeFileSync(tmp, src, 'utf8');
  fs.renameSync(tmp, target);

  ok('applied', { file: target, marker: MARKER });
})();
