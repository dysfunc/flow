#!/usr/bin/env node
/**
 * pi-bundle-mcp-runtime-conversation-id-egress.patch.js  (v2)
 *
 * Injects x-openclaw-conversation-id onto outbound MCP HTTP requests
 * (StreamableHTTPClientTransport + SSEClientTransport) at REQUEST time,
 * reading the current value from the global AsyncLocalStorage the ingress
 * patch sets.
 *
 * v1 was wrong: it mutated `requestInit.headers` at transport-construction
 * time. But MCP transports are cached by getCatalog() the first time the
 * catalog is fetched, so `requestInit` is frozen with whatever conv-id was
 * active at catalog-init (typically: none, because catalog loads happen
 * eagerly during agent boot, before any per-turn ALS scope exists). All
 * subsequent callTool() / _list_tools() calls reuse the stale transport,
 * baking in an empty conv-id for the lifetime of the process.
 *
 * v2 fixes this by wrapping the `fetch` function passed to each transport.
 * The wrapper reads ALS on every call, mutates the per-call `init.headers`,
 * and forwards. Result: even though the transport is cached, the fetch
 * function attached to it reads the live conv-id on every HTTP request,
 * including tools/call after catalog initialization.
 *
 * Target: /usr/lib/node_modules/openclaw/dist/pi-bundle-mcp-runtime-*.js
 * Marker: openclaw-patch:conversation-id-mcp-egress-v1
 *   (Marker name unchanged so verify.yml + expected-signatures keep working;
 *    v2 supersedes v1 in semantics only.)
 *
 * Companion patches:
 *   - openai-http-conversation-id-ingress.patch.js  (the producer)
 *
 * Behavior:
 *   - Resolves the same global symbol-keyed AsyncLocalStorage the ingress
 *     patch uses (Symbol.for("openclaw.patch.conversationIdAls")).
 *   - Builds a fetch wrapper that, on every call:
 *       1) reads conversationId from ALS
 *       2) if present, clones init.headers (preserves all existing) and
 *          adds x-openclaw-conversation-id
 *       3) delegates to fetchWithUndici (or global fetch as fallback)
 *   - Both StreamableHTTPClientTransport (streamable-http) and
 *     SSEClientTransport (sse) now receive this wrapped fetch via
 *     opts.fetch. SSE's eventSourceInit.fetch is also wrapped.
 *   - Original baked-in transport headers (`resolved.headers`) are left
 *     intact; we only ADD conv-id at call time when ALS has one.
 *   - Idempotent: detects marker and skips re-apply.
 *
 * Revert: npm install -g openclaw   (restores stock dist/)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = 'openclaw-patch:conversation-id-mcp-egress-v1';

const HELPER = [
  '/* ' + MARKER + ' (v2 — per-call fetch wrapper, transport-cache-safe) */',
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
  '// Wraps a fetch-like function so x-openclaw-conversation-id is added',
  '// to every outbound request from the current ALS scope at call time.',
  '// init.headers can be a Headers, plain object, or array of pairs; the',
  '// wrapper normalizes to a plain object for the merged copy.',
  'function __openclawWrapMcpFetch(innerFetch) {',
  '\tconst fn = (typeof innerFetch === "function") ? innerFetch : ((u, i) => fetch(u, i));',
  '\treturn async function __openclawConvIdFetch(input, init) {',
  '\t\tconst convId = __openclawCurrentConvId();',
  '\t\tif (!convId) return fn(input, init);',
  '\t\tconst nextInit = init && typeof init === "object" ? { ...init } : {};',
  '\t\tlet merged;',
  '\t\tconst h = nextInit.headers;',
  '\t\tif (h && typeof h.set === "function" && typeof h.get === "function") {',
  '\t\t\t// Headers / Headers-like — clone via constructor so we don\'t',
  '\t\t\t// mutate the caller\'s object.',
  '\t\t\tmerged = new (h.constructor)(h);',
  '\t\t\ttry { merged.set("x-openclaw-conversation-id", convId); } catch (_e) {}',
  '\t\t} else if (Array.isArray(h)) {',
  '\t\t\tmerged = h.filter((p) => Array.isArray(p) && String(p[0]).toLowerCase() !== "x-openclaw-conversation-id");',
  '\t\t\tmerged.push(["x-openclaw-conversation-id", convId]);',
  '\t\t} else if (h && typeof h === "object") {',
  '\t\t\tmerged = { ...h, "x-openclaw-conversation-id": convId };',
  '\t\t} else {',
  '\t\t\tmerged = { "x-openclaw-conversation-id": convId };',
  '\t\t}',
  '\t\tnextInit.headers = merged;',
  '\t\treturn fn(input, nextInit);',
  '\t};',
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

  let src = fs.readFileSync(target, 'utf8');

  // v1 anchor strings (we may have applied v1 earlier in this same dist).
  // To upgrade in place, we first revert v1's two replacements back to the
  // stock anchors, then apply v2. v2 is detected by the additional helper
  // function name __openclawWrapMcpFetch.
  //
  // The streamable-http construction shape changed between OpenClaw
  // 2026.5.5 and 2026.5.19:
  //   - <=2026.5.5: single-line, no `fetch:` field
  //   - >=2026.5.19: multi-line, default fetch =
  //     fetchStreamableHttpWithRedirectScrub (security-sensitive redirect
  //     scrubbing). The patch must COMPOSE with that, not replace it.
  //
  // We detect which shape is present at apply time and use matching
  // anchor + replacement. v3 marker comment in the replacement is what
  // expected-signatures.txt grep'es for, so it stays unchanged.
  const STOCK_STREAMABLE_LEGACY =
    'transport: new StreamableHTTPClientTransport(new URL(resolved.url), { requestInit: resolved.headers ? { headers: resolved.headers } : void 0 }),';
  const STOCK_STREAMABLE_MODERN =
    'transport: new StreamableHTTPClientTransport(new URL(resolved.url), {\n\t\t\trequestInit: resolved.headers ? { headers: resolved.headers } : void 0,\n\t\t\tfetch: fetchStreamableHttpWithRedirectScrub\n\t\t}),';
  const V1_STREAMABLE =
    'transport: new StreamableHTTPClientTransport(new URL(resolved.url), (() => { const __h = __openclawWithConvIdHeader(resolved.headers); return { requestInit: __h ? { headers: __h } : void 0 }; })()),';

  const STOCK_SSE_HEADERS_LINE = 'const headers = { ...resolved.headers };';
  const V1_SSE_HEADERS_LINE =
    'const headers = (() => { const __h = __openclawWithConvIdHeader(resolved.headers); return __h ? { ...__h } : {}; })();';

  // Detect v2 (idempotency): v2 introduces the wrapper helper.
  if (src.indexOf('__openclawWrapMcpFetch') !== -1) {
    ok('already-applied', { file: target, version: 'v2' });
  }

  // If v1 markers are present, roll them back before applying v2 so the
  // anchors needed for v2 are the stock ones. (v1 only ever ran against
  // the legacy single-line shape, so the rollback target is the legacy
  // STOCK_STREAMABLE regardless of which dist version we're patching.)
  if (src.indexOf(V1_STREAMABLE) !== -1) {
    src = src.replace(V1_STREAMABLE, STOCK_STREAMABLE_LEGACY);
  }
  if (src.indexOf(V1_SSE_HEADERS_LINE) !== -1) {
    src = src.replace(V1_SSE_HEADERS_LINE, STOCK_SSE_HEADERS_LINE);
  }
  // Strip any leftover v1 helper block (the lines defining __openclawCurrentConvId
  // and __openclawWithConvIdHeader). We replace the whole region from the
  // v1 marker comment up to the function resolveMcpTransport anchor.
  const V1_MARKER_LINE = '/* ' + MARKER + ' */';
  const V1_HELPER_HEAD = src.indexOf(V1_MARKER_LINE);
  if (V1_HELPER_HEAD !== -1) {
    const fnAnchor = src.indexOf('function resolveMcpTransport(', V1_HELPER_HEAD);
    if (fnAnchor === -1) fail('found v1 helper but no resolveMcpTransport anchor to bound it');
    src = src.slice(0, V1_HELPER_HEAD) + src.slice(fnAnchor);
  }

  // From this point, `src` is at the v1-rolled-back / stock state. Apply v2.
  // Detect which streamable shape is present in this dist version.
  let streamableMode;
  if (src.indexOf(STOCK_STREAMABLE_LEGACY) !== -1) {
    streamableMode = 'legacy';
  } else if (src.indexOf(STOCK_STREAMABLE_MODERN) !== -1) {
    streamableMode = 'modern';
  } else {
    fail('stock streamable-http anchor not found (neither legacy nor modern shape) — upstream rewrote the transport construction site; patch needs rewrite');
  }
  if (src.indexOf(STOCK_SSE_HEADERS_LINE) === -1) {
    fail('stock sse headers anchor not found after v1 rollback');
  }

  // Insert helper above the function.
  const HELPER_ANCHOR = 'function resolveMcpTransport(';
  if (src.indexOf(HELPER_ANCHOR) === -1) fail('helper anchor (resolveMcpTransport) not found');
  src = src.replace(HELPER_ANCHOR, HELPER + HELPER_ANCHOR);

  // Streamable: wrap opts.fetch.
  //   - legacy (<=2026.5.5): no fetch field, so we add one passing undefined
  //     (wrapper falls back to global fetch)
  //   - modern (>=2026.5.19): wrap fetchStreamableHttpWithRedirectScrub so
  //     the redirect-scrubbing behavior is preserved
  let STREAMABLE_REPLACEMENT;
  if (streamableMode === 'legacy') {
    STREAMABLE_REPLACEMENT =
      'transport: new StreamableHTTPClientTransport(new URL(resolved.url), { requestInit: resolved.headers ? { headers: resolved.headers } : void 0, fetch: __openclawWrapMcpFetch(undefined) }),';
    src = src.replace(STOCK_STREAMABLE_LEGACY, STREAMABLE_REPLACEMENT);
  } else {
    STREAMABLE_REPLACEMENT =
      'transport: new StreamableHTTPClientTransport(new URL(resolved.url), {\n\t\t\trequestInit: resolved.headers ? { headers: resolved.headers } : void 0,\n\t\t\tfetch: __openclawWrapMcpFetch(fetchStreamableHttpWithRedirectScrub)\n\t\t}),';
    src = src.replace(STOCK_STREAMABLE_MODERN, STREAMABLE_REPLACEMENT);
  }
  if (src.indexOf(STREAMABLE_REPLACEMENT) === -1) fail('streamable replacement failed to land (mode=' + streamableMode + ')');

  // SSE: wrap fetchWithUndici (and the eventSourceInit fetch).
  // The stock construction is:
  //   transport: new SSEClientTransport(new URL(resolved.url), {
  //     requestInit: hasHeaders ? { headers } : void 0,
  //     fetch: fetchWithUndici,
  //     eventSourceInit: { fetch: buildSseEventSourceFetch(headers) }
  //   }),
  const STOCK_SSE_FETCH = 'fetch: fetchWithUndici,';
  const SSE_FETCH_REPLACEMENT = 'fetch: __openclawWrapMcpFetch(fetchWithUndici),';
  if (src.indexOf(STOCK_SSE_FETCH) === -1) fail('stock sse fetch anchor not found');
  src = src.replace(STOCK_SSE_FETCH, SSE_FETCH_REPLACEMENT);

  const STOCK_SSE_ES_FETCH = 'eventSourceInit: { fetch: buildSseEventSourceFetch(headers) }';
  const SSE_ES_FETCH_REPLACEMENT = 'eventSourceInit: { fetch: __openclawWrapMcpFetch(buildSseEventSourceFetch(headers)) }';
  if (src.indexOf(STOCK_SSE_ES_FETCH) === -1) fail('stock sse eventSourceInit fetch anchor not found');
  src = src.replace(STOCK_SSE_ES_FETCH, SSE_ES_FETCH_REPLACEMENT);

  if (src.indexOf(MARKER) === -1) fail('post-patch marker missing');
  if (src.indexOf('__openclawWrapMcpFetch') === -1) fail('post-patch wrapper helper missing');

  const tmp = target + '.patch-tmp';
  fs.writeFileSync(tmp, src, 'utf8');
  fs.renameSync(tmp, target);

  ok('applied', { file: target, marker: MARKER, version: 'v2' });
})();
