// identity.js
//
// Caller-supplied identity normalization for the gateway-proxy.
//
// Trust model: gateway-proxy sits behind chat-worker (Supabase edge function),
// which authenticates the user via Supabase JWT server-side and then calls the
// gateway with the shared gateway-password (existing trust gate). When the
// password gate passes, we trust the three caller-supplied identity headers:
//
//   x-openclaw-acting-user          → Supabase user UUID
//   x-openclaw-acting-user-email    → verified email
//   x-openclaw-acting-user-display  → display name (full name or email local-part)
//
// These three headers are normalized into a single forward-compatible header
// for downstream OpenClaw consumption:
//
//   x-openclaw-acting-user-claim    → base64(JSON({channel, user_id, email, display, issued_at}))
//
// The raw three headers are stripped before forwarding upstream so they cannot
// be confused with client-supplied input (defense-in-depth, even though raw
// browser→gateway calls would fail the password check anyway).
//
// Modes (env: GATEWAY_PROXY_ACTING_USER_MODE):
//   off      Pass through unchanged. Phase 1 default; zero behavior change.
//   stamp    Validate + normalize headers. Forward claim. Tolerate missing
//            headers (existing callers without chat-worker keep working).
//            Phase 1.5 default.
//   enforce  Same as stamp, but reject (4xx) on /chat paths if headers are
//            missing/malformed or if the email domain doesn't match the
//            configured allow-list. Phase 3 default.

import crypto from "node:crypto";

const HDR_USER_ID  = "x-openclaw-acting-user";
const HDR_EMAIL    = "x-openclaw-acting-user-email";
const HDR_DISPLAY  = "x-openclaw-acting-user-display";
const HDR_CLAIM    = "x-openclaw-acting-user-claim";
const HDR_REQ_ID   = "x-openclaw-proxy-request-id";
const HDR_CONV_ID  = "x-openclaw-conversation-id";

// Opaque string per relay contract (2026-05-19). Length cap + control-byte
// filter are the only sanity guards. Verbatim pass-through otherwise.
const CONV_ID_MAX_LEN = 128;
const CONV_ID_CTRL_RE = /[\u0000-\u001f\u007f]/;

const VALID_MODES = new Set(["off", "stamp", "enforce"]);

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function loadIdentityConfig(env = process.env) {
  const rawMode = (env.GATEWAY_PROXY_ACTING_USER_MODE || "off").toLowerCase().trim();
  const mode = VALID_MODES.has(rawMode) ? rawMode : "off";

  const rawDomains = (env.GATEWAY_PROXY_ALLOWED_EMAIL_DOMAINS || "").trim();
  const allowedDomains = rawDomains
    ? rawDomains.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
    : [];

  const enforcedPathsRaw = (env.GATEWAY_PROXY_ENFORCE_PATHS || "/chat").trim();
  const enforcedPaths = enforcedPathsRaw
    ? enforcedPathsRaw.split(",").map((p) => p.trim()).filter(Boolean)
    : ["/chat"];

  return { mode, allowedDomains, enforcedPaths };
}

function pickHeader(headers, name) {
  const v = headers[name];
  if (Array.isArray(v)) return v[0]?.trim() || undefined;
  if (typeof v === "string") return v.trim() || undefined;
  return undefined;
}

// Returns sanitized conversation id (or undefined) plus a reason on rejection.
// Never throws. Never mutates the inbound header dict.
function sanitizeConversationId(raw) {
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== "string") return { value: undefined, reason: "non-string" };
  if (raw.length === 0) return { value: undefined };
  if (raw.length > CONV_ID_MAX_LEN) return { value: undefined, reason: "length>" + CONV_ID_MAX_LEN };
  if (CONV_ID_CTRL_RE.test(raw)) return { value: undefined, reason: "control-byte" };
  return { value: raw };
}

function generateRequestId() {
  return crypto.randomBytes(8).toString("hex");
}

function pathMatchesEnforce(reqPath, enforcedPaths) {
  if (!reqPath) return false;
  const p = reqPath.split("?")[0];
  return enforcedPaths.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

function emailDomain(email) {
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Result shape:
 *   {
 *     action: "pass" | "stamp" | "reject",
 *     mutatedHeaders?: object,   // for action=stamp/pass: the headers to forward
 *     rejection?: {              // for action=reject
 *       statusCode: number,
 *       body: object,
 *     },
 *     audit: {                   // always present, for logging
 *       requestId: string,
 *       mode: string,
 *       claimPresent: boolean,
 *       userId?: string,
 *       email?: string,
 *       reason?: string,
 *     },
 *   }
 *
 * Caller is responsible for actually writing the rejection or forwarding
 * mutatedHeaders to the upstream request.
 */
export function evaluateIdentity({ reqHeaders, reqPath, config }) {
  const requestId = generateRequestId();
  const { mode, allowedDomains, enforcedPaths } = config;

  // Conversation-id (relay 2026-05-19) is read in EVERY mode, including off,
  // because mcp-relay / personal-relay need it on the outbound MCP request
  // regardless of identity-stamping posture. Treated as opaque string with a
  // length+control-byte sanity guard. Forwarded verbatim via the header
  // passthrough in proxy-core (forwardRequestHeaders); when stamping a
  // claim, also included in the claim JSON for observability.
  const convIdRaw = pickHeader(reqHeaders, HDR_CONV_ID);
  const convIdSanitized = sanitizeConversationId(convIdRaw);
  const conversationId = convIdSanitized.value;
  const convIdAuditReason = convIdSanitized.reason;

  // --- Mode: off -----------------------------------------------------------
  // Pass-through. Don't read identity headers, don't normalize, don't strip.
  // Phase 1 default.
  if (mode === "off") {
    return {
      action: "pass",
      mutatedHeaders: reqHeaders,
      audit: {
        requestId,
        conversationId,
        conversationIdReason: convIdAuditReason,
        mode,
        claimPresent: false,
      },
    };
  }

  // --- Modes: stamp / enforce ---------------------------------------------
  const userIdRaw = pickHeader(reqHeaders, HDR_USER_ID);
  const email     = pickHeader(reqHeaders, HDR_EMAIL);
  const display   = pickHeader(reqHeaders, HDR_DISPLAY);

  // The relay may send a `:`-suffixed user id of the form
  // "<uuid>:<conversation_id>" so a single header carries both pieces.
  // Split the suffix off, validate the UUID prefix, and treat the suffix as
  // an additional conversation_id source (only used if a dedicated
  // x-openclaw-conversation-id header was not also supplied).
  let userId = userIdRaw;
  let conversationIdFromUserId = undefined;
  if (typeof userIdRaw === "string" && userIdRaw.includes(":")) {
    const idx = userIdRaw.indexOf(":");
    userId = userIdRaw.slice(0, idx);
    const suffix = userIdRaw.slice(idx + 1);
    const sanitized = sanitizeConversationId(suffix);
    conversationIdFromUserId = sanitized.value;
  }

  const havePartial = Boolean(userId || email || display);
  const enforcedHere = mode === "enforce" && pathMatchesEnforce(reqPath, enforcedPaths);

  if (!havePartial) {
    if (enforcedHere) {
      return {
        action: "reject",
        rejection: {
          statusCode: 401,
          body: {
            error: "acting_user_required",
            message: "Acting user identity headers are required on this path.",
            request_id: requestId,
          },
        },
        audit: { requestId, mode, claimPresent: false, reason: "missing on enforced path" },
      };
    }
    // stamp mode without identity headers: pass through unchanged.
    return {
      action: "pass",
      mutatedHeaders: reqHeaders,
      audit: { requestId, mode, claimPresent: false },
    };
  }

  // Validate shapes.
  const validations = [];
  if (!userId)                       validations.push("missing user id");
  else if (!UUID_RE.test(userId))    validations.push("user id is not a uuid");
  if (!email)                        validations.push("missing email");
  else if (!EMAIL_RE.test(email))    validations.push("email is malformed");
  if (display && display.length > 256) validations.push("display name too long");

  if (validations.length > 0) {
    if (enforcedHere) {
      return {
        action: "reject",
        rejection: {
          statusCode: 400,
          body: {
            error: "acting_user_malformed",
            message: "Acting user identity headers failed validation.",
            details: validations,
            request_id: requestId,
          },
        },
        audit: { requestId, mode, claimPresent: true, userId, email, reason: validations.join("; ") },
      };
    }
    // stamp mode tolerates malformed by skipping the claim and passing through.
    return {
      action: "pass",
      mutatedHeaders: reqHeaders,
      audit: { requestId, mode, claimPresent: true, userId, email, reason: "validation failed (tolerated in stamp mode): " + validations.join("; ") },
    };
  }

  // Domain-scope check.
  if (allowedDomains.length > 0) {
    const domain = emailDomain(email);
    if (!domain || !allowedDomains.includes(domain)) {
      // Domain mismatch is treated as a real rejection in BOTH stamp and
      // enforce modes — silently letting a wrong-tenant identity through is
      // exactly the bug class today's colinks fallback represents. Failing
      // closed here is intentional, even before Phase 3.
      return {
        action: "reject",
        rejection: {
          statusCode: 403,
          body: {
            error: "acting_user_domain_mismatch",
            message: "Acting user email domain is not in the configured allowed domain list.",
            allowed_domains: allowedDomains,
            request_id: requestId,
          },
        },
        audit: { requestId, mode, claimPresent: true, userId, email, reason: "domain not in allow-list" },
      };
    }
  }

  // Build the normalized claim.
  // Prefer the dedicated x-openclaw-conversation-id header; fall back to
  // a suffix split from the user-id header. Either way, the value is
  // sanitized (length<=128, no control bytes) and forwarded verbatim.
  const effectiveConversationId = conversationId || conversationIdFromUserId;
  const claim = {
    channel: "webchat",
    user_id: userId,
    email,
    display: display || email.split("@")[0],
    issued_at: Date.now(),
  };
  if (effectiveConversationId) claim.conversation_id = effectiveConversationId;
  const claimB64 = Buffer.from(JSON.stringify(claim), "utf8").toString("base64");

  // Mutate headers: strip the raw three, add the normalized claim + request id.
  // Use lowercase keys (Node's http module canonicalizes to lowercase already,
  // but be explicit).
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    const lk = k.toLowerCase();
    if (lk === HDR_USER_ID || lk === HDR_EMAIL || lk === HDR_DISPLAY) continue;
    out[k] = v;
  }
  out[HDR_CLAIM]  = claimB64;
  out[HDR_REQ_ID] = requestId;
  // Always set the dedicated conv-id header from the effective value so the
  // downstream ingress patch can capture it into AsyncLocalStorage, even when
  // the relay only sent it via the user-id suffix.
  if (effectiveConversationId) out[HDR_CONV_ID] = effectiveConversationId;

  return {
    action: "stamp",
    mutatedHeaders: out,
    audit: {
      requestId,
      mode,
      claimPresent: true,
      userId,
      email,
      conversationId: effectiveConversationId,
      conversationIdSource: conversationId ? "header" : (conversationIdFromUserId ? "user-id-suffix" : undefined),
      conversationIdReason: convIdAuditReason,
    },
  };
}

export const HEADER_NAMES = {
  USER_ID: HDR_USER_ID,
  EMAIL: HDR_EMAIL,
  DISPLAY: HDR_DISPLAY,
  CLAIM: HDR_CLAIM,
  REQUEST_ID: HDR_REQ_ID,
};
