#!/usr/bin/env node
/**
 * openai-http-sender-block.patch.js
 *
 * Adds a Sender JSON block to the user prompt on /v1/chat/completions ingress.
 * Sourced from payload.metadata.acting_user (sent by chat-worker / relay).
 *
 * Target: /usr/lib/node_modules/openclaw/dist/openai-http-*.js
 * Marker: openclaw-patch:sender-block-v1
 *
 * Behavior:
 *   - Reads payload.metadata.acting_user = { id, email, display } if present
 *   - Falls back gracefully if missing/malformed (no injection, no error)
 *   - Caps field lengths defensively (display 256ch, email 320ch, id 128ch)
 *   - Strips control chars from identity fields before injection
 *   - Prepends Conversation info + Sender JSON blocks (matching the format
 *     of buildInboundUserContextPrefix in get-reply-*.js) to prompt.message
 *   - Idempotent: detects marker and skips re-apply
 *
 * Revert: npm install -g openclaw   (restores stock dist/)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = 'openclaw-patch:sender-block-v1';

// Helper function injected just before handleOpenAiHttpRequest.
// Using string concat over template literals to avoid backtick collision with
// the json fence markers it has to emit. Indented with tabs to match
// surrounding code style.
const HELPER_BODY = [
  '/* ' + MARKER + ' */',
  'function buildSenderPrefixFromActingUser_OPENCLAW_PATCH(payload) {',
  '\ttry {',
  '\t\tconst meta = payload && typeof payload === "object" ? payload.metadata : undefined;',
  '\t\tconst actingUser = meta && typeof meta === "object" ? meta.acting_user : undefined;',
  '\t\tif (!actingUser || typeof actingUser !== "object") return "";',
  '\t\tconst clampStr = (v, max) => {',
  '\t\t\tif (typeof v !== "string") return undefined;',
  '\t\t\tconst trimmed = v.replace(/[\\u0000-\\u001f\\u007f]/g, "").trim();',
  '\t\t\tif (!trimmed) return undefined;',
  '\t\t\treturn trimmed.length > max ? trimmed.slice(0, max) : trimmed;',
  '\t\t};',
  '\t\tconst id = clampStr(actingUser.id, 128);',
  '\t\tconst email = clampStr(actingUser.email, 320);',
  '\t\tconst display = clampStr(actingUser.display, 256);',
  '\t\tif (!id && !email && !display) return "";',
  '\t\tconst label = display || email || id;',
  '\t\tconst conversationInfo = { sender_id: id, sender: label };',
  '\t\tconst senderInfo = { label: label, id: id, name: display, username: email };',
  '\t\tconst format = (heading, obj) => {',
  '\t\t\tconst filtered = {};',
  '\t\t\tfor (const k of Object.keys(obj)) { if (obj[k] !== undefined) filtered[k] = obj[k]; }',
  '\t\t\tconst fence = String.fromCharCode(96, 96, 96);',
  '\t\t\treturn heading + "\\n" + fence + "json\\n" + JSON.stringify(filtered, null, 2) + "\\n" + fence;',
  '\t\t};',
  '\t\treturn format("Conversation info (untrusted metadata):", conversationInfo) + "\\n\\n" + format("Sender (untrusted metadata):", senderInfo);',
  '\t} catch (_err) {',
  '\t\treturn "";',
  '\t}',
  '}',
  ''
].join('\n');

const ANCHOR_LINE = '\tconst prompt = buildAgentPrompt(payload.messages, activeTurnContext.activeUserMessageIndex);';
const ANCHOR_REPLACEMENT = [
  '\tconst prompt = buildAgentPrompt(payload.messages, activeTurnContext.activeUserMessageIndex);',
  '\t/* ' + MARKER + ' */',
  '\t{',
  '\t\tconst senderPrefix = buildSenderPrefixFromActingUser_OPENCLAW_PATCH(payload);',
  '\t\tif (senderPrefix) {',
  '\t\t\tprompt.message = prompt.message ? senderPrefix + "\\n\\n" + prompt.message : senderPrefix;',
  '\t\t}',
  '\t}'
].join('\n');

const HELPER_ANCHOR = 'async function handleOpenAiHttpRequest(req, res, opts) {';

function findTarget(distDir) {
  const candidates = fs.readdirSync(distDir).filter((f) => /^openai-http-[A-Za-z0-9_-]+\.js$/.test(f));
  if (candidates.length === 0) throw new Error('no openai-http-*.js file found in ' + distDir);
  if (candidates.length > 1) throw new Error('multiple openai-http-*.js files found: ' + candidates.join(', '));
  return path.join(distDir, candidates[0]);
}

function applyPatch(distDir, opts) {
  opts = opts || {};
  const targetPath = findTarget(distDir);
  const source = fs.readFileSync(targetPath, 'utf8');

  if (source.indexOf(MARKER) !== -1) {
    return { targetPath: targetPath, status: 'already-applied' };
  }
  if (source.indexOf(ANCHOR_LINE) === -1) {
    return { targetPath: targetPath, status: 'anchor-missing', detail: 'ANCHOR_LINE not found' };
  }
  if (source.indexOf(HELPER_ANCHOR) === -1) {
    return { targetPath: targetPath, status: 'anchor-missing', detail: 'HELPER_ANCHOR not found' };
  }
  if (opts.dryRun) {
    return { targetPath: targetPath, status: 'would-apply' };
  }

  let patched = source.replace(HELPER_ANCHOR, HELPER_BODY + '\n' + HELPER_ANCHOR);
  patched = patched.replace(ANCHOR_LINE, ANCHOR_REPLACEMENT);

  const markerCount = (patched.match(new RegExp(MARKER.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g')) || []).length;
  if (markerCount < 2) {
    return { targetPath: targetPath, status: 'patch-failed', detail: 'marker count: ' + markerCount };
  }

  const backupPath = targetPath + '.before-sender-block-patch';
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, source);
  fs.writeFileSync(targetPath, patched);
  return { targetPath: targetPath, status: 'applied', backupPath: backupPath };
}

if (require.main === module) {
  const distDir = process.argv[2] || '/usr/lib/node_modules/openclaw/dist';
  const dryRun = process.argv.indexOf('--dry-run') !== -1;
  try {
    const result = applyPatch(distDir, { dryRun: dryRun });
    console.log(JSON.stringify(result, null, 2));
    const ok = result.status === 'applied' || result.status === 'already-applied' || result.status === 'would-apply';
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('patch error:', err.message);
    process.exit(2);
  }
}

module.exports = { applyPatch: applyPatch, findTarget: findTarget, MARKER: MARKER };
