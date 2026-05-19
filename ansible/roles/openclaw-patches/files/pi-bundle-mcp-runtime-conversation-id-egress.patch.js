#!/usr/bin/env node
/**
 * pi-bundle-mcp-runtime-conversation-id-egress.patch.js
 *
 * Injects x-openclaw-conversation-id onto outbound MCP HTTP requests
 * (StreamableHTTPClientTransport + SSEClientTransport) when a conversation
 * id is available in the current AsyncLocalStorage scope set by the
 * ingress patch.
 *
 * Target: /usr/lib/node_modules/openclaw/dist/pi-bundle-mcp-runtime-*.js
 * Marker: openclaw-patch:conversation-id-mcp-egress-v1
 *
 * Companion patches:
 *   - openai-http-conversation-id-ingress.patch.js  (the producer)
 *
 * Behavior:
 *   - Resolves the same global symbol-keyed AsyncLocalStorage the ingress
 *     patch uses (Symbol.for("openclaw.patch.conversationIdAls")).
 *   - In resolveMcpTransport(), just before constructing the transport,
 *     reads the active scope and, if conversationId is present, clones
 *     resolved.headers and adds x-openclaw-conversation-id.
 *   - Falls through to stock behavior on:
 *       - No active scope (no conv-id sent, no scope installed)
 *       - Missing/empty conversationId (the ingress patch already sanitized)
 *       - Any thrown error reading the store (defensive)
 *   - Does NOT mutate resolved.headers in place — the original dict may
 *     be reused across server-config refreshes.
 *   - Idempotent: detects marker and skips re-apply.
 *
 * Revert: npm install -g openclaw   (restores stock dist/)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = 'openclaw-patch:conversation-id-mcp-egress-v1';

const HELPER = [
  '/* ' + MARKER + ' */',
  'const __openclawConvIdAls_SYM = Symbol.for("openclaw.patch.conversationIdAls");',
  'function __openclawCurrentConvId() {',
  '\ttry {',
  '\t\tconst als = globalThis[__openclawConvIdAls_SYM];',
  '\t\tif (!als || typeof als.getStore !== "function") return undefined;',
  '\t\tconst store = als.getStore();',
  '\t\tif (!store || typeof store !== "object") return undefined;',
  '\t\tconst v = store.conversationId;',
  '\t\treturn typeof v === "string" && v.length > 0 && v.length <= 128 ? v : undefined;',
  '\t} catch (_e) { return undefined; }',
  '}',
  'function __openclawWithConvIdHeader(headers) {',
  '\tconst convId = __openclawCurrentConvId();',
  '\tif (!convId) return headers || undefined;',
  '\tconst base = headers && typeof headers === "object" ? headers : {};',
  '\treturn Object.assign({}, base, { "x-openclaw-conversation-id": convId });',
  '}',
  ''
].join('\n');

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
    const matches = fs.readdirSync(distDir).filter(f => /^pi-bundle-mcp-runtime-.*\.js$/.test(f));
    if (matches.length === 0) fail('no pi-bundle-mcp-runtime-*.js found in ' + distDir);
    if (matches.length > 1) fail('multiple pi-bundle-mcp-runtime-*.js found: ' + matches.join(', '));
    target = path.join(distDir, matches[0]);
  } catch (e) {
    fail('cannot read distDir ' + distDir + ': ' + e.message);
  }

  const src = fs.readFileSync(target, 'utf8');

  if (src.indexOf(MARKER) !== -1) {
    ok('already-applied', { file: target });
  }

  // Anchor 1: streamable-http transport construction.
  const STREAMABLE_ANCHOR =
    'transport: new StreamableHTTPClientTransport(new URL(resolved.url), { requestInit: resolved.headers ? { headers: resolved.headers } : void 0 }),';
  const STREAMABLE_REPLACEMENT =
    'transport: new StreamableHTTPClientTransport(new URL(resolved.url), (() => { const __h = __openclawWithConvIdHeader(resolved.headers); return { requestInit: __h ? { headers: __h } : void 0 }; })()),';

  // Anchor 2: SSE transport headers are pre-built in a local `headers` const
  // a few lines above the transport call. We need to inject conv-id into
  // that local. The original block:
  //
  //   const headers = { ...resolved.headers };
  //   const hasHeaders = Object.keys(headers).length > 0;
  //   return {
  //     transport: new SSEClientTransport(new URL(resolved.url), {
  //       requestInit: hasHeaders ? { headers } : void 0,
  //       fetch: fetchWithUndici,
  //       eventSourceInit: { fetch: buildSseEventSourceFetch(headers) }
  //     }),
  //
  // Patch only the first line (introduces conv-id into the dict).
  const SSE_ANCHOR = 'const headers = { ...resolved.headers };';
  const SSE_REPLACEMENT =
    'const headers = (() => { const __h = __openclawWithConvIdHeader(resolved.headers); return __h ? { ...__h } : {}; })();';

  if (src.indexOf(STREAMABLE_ANCHOR) === -1) {
    fail('streamable-http anchor not found in ' + target);
  }
  if (src.indexOf(SSE_ANCHOR) === -1) {
    fail('sse anchor not found in ' + target);
  }

  // Find an insertion point for the helper. Insert just before the first
  // use site (the streamable anchor) for locality. Use a stable anchor
  // string that lives above both uses: "function resolveMcpTransport(".
  const HELPER_ANCHOR = 'function resolveMcpTransport(';
  if (src.indexOf(HELPER_ANCHOR) === -1) {
    fail('helper anchor (resolveMcpTransport function) not found in ' + target);
  }

  // Apply: helper above the function, then two anchor replacements.
  let next = src.replace(HELPER_ANCHOR, HELPER + HELPER_ANCHOR);
  if (next === src) fail('helper insertion failed');

  next = next.replace(STREAMABLE_ANCHOR, STREAMABLE_REPLACEMENT);
  if (next.indexOf(STREAMABLE_REPLACEMENT) === -1) fail('streamable replacement failed');

  next = next.replace(SSE_ANCHOR, SSE_REPLACEMENT);
  if (next.indexOf(SSE_REPLACEMENT) === -1) fail('sse replacement failed');

  if (next.indexOf(MARKER) === -1) fail('post-patch marker missing');

  const tmp = target + '.patch-tmp';
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, target);

  ok('applied', { file: target, marker: MARKER });
})();
