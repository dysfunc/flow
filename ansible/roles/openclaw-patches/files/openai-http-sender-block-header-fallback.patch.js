#!/usr/bin/env node
/**
 * openai-http-sender-block-header-fallback.patch.js
 *
 * Supplemental patch on top of openai-http-sender-block.patch.js (v1).
 *
 * The v1 patch reads acting_user identity from payload.metadata.acting_user
 * (request body). The relay UI surface stamps identity via gateway-proxy
 * as the `x-openclaw-acting-user-claim` header instead — so v1 falls back
 * to an empty Sender block and the prompt label degrades to
 * `openclaw-control-ui`.
 *
 * This patch teaches the v1 helper to ALSO read from the claim header
 * when the body field is missing, by:
 *   1) extending the helper signature to accept `req`
 *   2) decoding `req.headers['x-openclaw-acting-user-claim']` as base64 JSON
 *   3) shaping {user_id,email,display} into the same {id,email,display}
 *      acting_user object the helper expects
 *   4) updating the call site to pass `req`
 *
 * Target: /usr/lib/node_modules/openclaw/dist/openai-http-*.js
 * Marker: openclaw-patch:sender-block-header-fallback-v1
 *
 * Requires: openclaw-patch:sender-block-v1 to already be present.
 *
 * Idempotent. Revert: npm install -g openclaw
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = 'openclaw-patch:sender-block-header-fallback-v1';
const PREREQ_MARKER = 'openclaw-patch:sender-block-v1';

// Original v1 helper start signature.
const V1_HELPER_SIG = 'function buildSenderPrefixFromActingUser_OPENCLAW_PATCH(payload) {';
// Replacement: take `req` and prepend a header-fallback block.
const V2_HELPER_SIG_AND_PRELUDE = [
  'function buildSenderPrefixFromActingUser_OPENCLAW_PATCH(payload, req) {',
  '\t/* ' + MARKER + ' */',
  '\t// Header-fallback shim: if the body doesn\'t carry acting_user but',
  '\t// gateway-proxy stamped x-openclaw-acting-user-claim, synthesize the',
  '\t// equivalent body shape so the rest of the helper just works.',
  '\ttry {',
  '\t\tconst hasBodyActingUser = payload && typeof payload === "object" && payload.metadata && typeof payload.metadata === "object" && payload.metadata.acting_user && typeof payload.metadata.acting_user === "object";',
  '\t\tif (!hasBodyActingUser && req && req.headers) {',
  '\t\t\tconst rawClaim = req.headers["x-openclaw-acting-user-claim"];',
  '\t\t\tconst claimStr = Array.isArray(rawClaim) ? rawClaim[0] : rawClaim;',
  '\t\t\tif (typeof claimStr === "string" && claimStr.length > 0 && claimStr.length <= 8192) {',
  '\t\t\t\tlet decoded;',
  '\t\t\t\ttry { decoded = JSON.parse(Buffer.from(claimStr, "base64").toString("utf8")); } catch (_e) {}',
  '\t\t\t\tif (decoded && typeof decoded === "object") {',
  '\t\t\t\t\tconst id = typeof decoded.user_id === "string" ? decoded.user_id : undefined;',
  '\t\t\t\t\tconst email = typeof decoded.email === "string" ? decoded.email : undefined;',
  '\t\t\t\t\tconst display = typeof decoded.display === "string" ? decoded.display : undefined;',
  '\t\t\t\t\tif (id || email || display) {',
  '\t\t\t\t\t\tconst syntheticActingUser = {};',
  '\t\t\t\t\t\tif (id) syntheticActingUser.id = id;',
  '\t\t\t\t\t\tif (email) syntheticActingUser.email = email;',
  '\t\t\t\t\t\tif (display) syntheticActingUser.display = display;',
  '\t\t\t\t\t\tconst basePayload = payload && typeof payload === "object" ? payload : {};',
  '\t\t\t\t\t\tconst baseMeta = basePayload.metadata && typeof basePayload.metadata === "object" ? basePayload.metadata : {};',
  '\t\t\t\t\t\tpayload = Object.assign({}, basePayload, { metadata: Object.assign({}, baseMeta, { acting_user: syntheticActingUser }) });',
  '\t\t\t\t\t}',
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t}',
  '\t} catch (_e) { /* fall through to v1 behavior */ }'
].join('\n');

// Original v1 call site.
const V1_CALL = 'const senderPrefix = buildSenderPrefixFromActingUser_OPENCLAW_PATCH(payload);';
// Replacement: pass req.
const V2_CALL = 'const senderPrefix = buildSenderPrefixFromActingUser_OPENCLAW_PATCH(payload, req); /* ' + MARKER + ' */';

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
    const matches = fs.readdirSync(distDir).filter(f => /^openai-http-.*\.js$/.test(f));
    if (matches.length === 0) fail('no openai-http-*.js found in ' + distDir);
    if (matches.length > 1) fail('multiple openai-http-*.js found: ' + matches.join(', '));
    target = path.join(distDir, matches[0]);
  } catch (e) {
    fail('cannot read distDir ' + distDir + ': ' + e.message);
  }

  const src = fs.readFileSync(target, 'utf8');

  if (src.indexOf(MARKER) !== -1) {
    ok('already-applied', { file: target });
  }
  if (src.indexOf(PREREQ_MARKER) === -1) {
    fail('prerequisite patch missing (' + PREREQ_MARKER + ') — apply openai-http-sender-block.patch.js first');
  }
  if (src.indexOf(V1_HELPER_SIG) === -1) {
    fail('v1 helper signature anchor not found: ' + V1_HELPER_SIG);
  }
  if (src.indexOf(V1_CALL) === -1) {
    fail('v1 call site anchor not found: ' + V1_CALL);
  }

  let next = src.replace(V1_HELPER_SIG, V2_HELPER_SIG_AND_PRELUDE);
  if (next === src) fail('helper signature replacement failed');
  next = next.replace(V1_CALL, V2_CALL);
  if (next.indexOf(MARKER) === -1) fail('post-patch marker missing');

  const tmp = target + '.patch-tmp';
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, target);

  ok('applied', { file: target, marker: MARKER });
})();
