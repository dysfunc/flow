#!/usr/bin/env node
/**
 * openai-http-conversation-id-ingress.patch.js
 *
 * Captures the x-openclaw-conversation-id request header on /v1/chat/completions
 * ingress and stashes it in a request-scoped AsyncLocalStorage that the
 * MCP-runtime egress patch can read on outbound MCP HTTP calls.
 *
 * Target: /usr/lib/node_modules/openclaw/dist/openai-http-*.js
 * Marker: openclaw-patch:conversation-id-ingress-v1
 *
 * Companion patches:
 *   - pi-bundle-mcp-runtime-conversation-id-egress.patch.js  (the consumer)
 *
 * Behavior:
 *   - Reads req.headers['x-openclaw-conversation-id'] (case-insensitive via
 *     Node's normalized req.headers — already lower-cased).
 *   - Caps at 128 chars and strips non-printable / control bytes. Forwards
 *     verbatim otherwise; treated as an opaque string (per relay 2026-05-19).
 *   - Stores in a global symbol-keyed AsyncLocalStorage so the MCP egress
 *     patch can resolveGlobalSingleton() the same key and read it inside
 *     the async chain of the tool call.
 *   - Wraps both the non-streaming and streaming dispatch sites
 *     (agentCommandFromIngress + subscribe loop) with als.run() so the
 *     header propagates through the await chain.
 *   - If the header is absent/empty/garbage, does NOT install the .run()
 *     wrapper (no perf cost on non-relay traffic).
 *   - Idempotent: detects marker and skips re-apply.
 *
 * Revert: npm install -g openclaw   (restores stock dist/)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = 'openclaw-patch:conversation-id-ingress-v1';

// The target file is ESM (uses `import`). We inject a top-of-file import
// for node:async_hooks plus the helper block immediately above the
// renamed handler.
const TOP_IMPORT = '/* ' + MARKER + ' */\nimport { AsyncLocalStorage as __OpenClawAsyncLocalStorage } from "node:async_hooks";\n';

// Shared symbol key for cross-bundle AsyncLocalStorage access. The MCP
// egress patch resolves the same key to read the value.
const ALS_HELPER = [
  '/* ' + MARKER + ' */',
  'const __openclawConvIdAls_SYM = Symbol.for("openclaw.patch.conversationIdAls");',
  'const __openclawConvIdAls = (() => {',
  '\ttry {',
  '\t\tconst g = globalThis;',
  '\t\tif (!g[__openclawConvIdAls_SYM]) g[__openclawConvIdAls_SYM] = new __OpenClawAsyncLocalStorage();',
  '\t\treturn g[__openclawConvIdAls_SYM];',
  '\t} catch (_e) { return null; }',
  '})();',
  'function __openclawSanitizeConvId(raw) {',
  '\tif (typeof raw !== "string") return undefined;',
  '\tif (raw.length === 0 || raw.length > 128) return undefined;',
  '\tif (/[\\u0000-\\u001f\\u007f]/.test(raw)) return undefined;',
  '\tconst trimmed = raw.trim();',
  '\treturn trimmed.length > 0 ? trimmed : undefined;',
  '}',
  'function __openclawCapturedConvId(req) {',
  '\ttry {',
  '\t\tif (!req || !req.headers) return undefined;',
  '\t\tconst v = req.headers["x-openclaw-conversation-id"];',
  '\t\tconst raw = Array.isArray(v) ? v[0] : v;',
  '\t\treturn __openclawSanitizeConvId(raw);',
  '\t} catch (_e) { return undefined; }',
  '}',
  ''
].join('\n');

// Wrap the handler body to capture the header and re-enter the original
// body inside als.run(). We patch handleOpenAiHttpRequest's body via a
// rename + thin wrapper.

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

  // Anchor: the original handler signature line.
  const ANCHOR = 'async function handleOpenAiHttpRequest(req, res, opts) {';
  if (src.indexOf(ANCHOR) === -1) {
    fail('anchor not found in ' + target + ': ' + ANCHOR);
  }

  // Strategy: rename original handler to __openclaw_orig_handleOpenAiHttpRequest,
  // and inject a new handleOpenAiHttpRequest that captures conv-id and runs the
  // original body inside als.run() when present.
  const RENAMED = 'async function __openclaw_orig_handleOpenAiHttpRequest(req, res, opts) {';

  if (src.indexOf(RENAMED) !== -1) {
    fail('renamed handler already present but marker missing — refusing to patch (manual cleanup required)');
  }

  const WRAPPER = [
    '/* ' + MARKER + ' */',
    'async function handleOpenAiHttpRequest(req, res, opts) {',
    '\tconst __openclawConvId = __openclawCapturedConvId(req);',
    '\tif (__openclawConvId && __openclawConvIdAls) {',
    '\t\treturn __openclawConvIdAls.run({ conversationId: __openclawConvId }, () =>',
    '\t\t\t__openclaw_orig_handleOpenAiHttpRequest(req, res, opts));',
    '\t}',
    '\treturn __openclaw_orig_handleOpenAiHttpRequest(req, res, opts);',
    '}',
    ''
  ].join('\n');

  // 1) Replace original signature with renamed signature.
  let next = src.replace(ANCHOR, RENAMED);
  if (next === src) fail('rename replacement failed (no-op)');

  // 2) Inject top-of-file import for AsyncLocalStorage (ESM file). Place
  // just before the first 'import ' line so it lands with the other imports.
  const firstImportIdx = next.indexOf('import ');
  if (firstImportIdx === -1) fail('no import statement found in target (ESM expected)');
  next = next.slice(0, firstImportIdx) + TOP_IMPORT + next.slice(firstImportIdx);

  // 3) Insert ALS helper + wrapper immediately BEFORE the renamed handler.
  // Find the position of the renamed signature in `next` and inject above it.
  const renamedIdx = next.indexOf(RENAMED);
  if (renamedIdx === -1) fail('cannot relocate renamed handler for wrapper insertion');

  const before = next.slice(0, renamedIdx);
  const after = next.slice(renamedIdx);
  next = before + ALS_HELPER + WRAPPER + after;

  // 3) Sanity: marker now present, and we still have exactly one
  // "handleOpenAiHttpRequest" export reference.
  if (next.indexOf(MARKER) === -1) fail('post-patch marker missing');
  if (next.indexOf('handleOpenAiHttpRequest') === -1) fail('post-patch handler reference missing');

  // 4) Atomic write.
  const tmp = target + '.patch-tmp';
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, target);

  ok('applied', { file: target, marker: MARKER });
})();
