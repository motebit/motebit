/**
 * Pure validation functions extracted from edge route handlers.
 * No I/O, no edge runtime dependencies — testable in any environment.
 */

// --- Constants ---

export const DAILY_LIMIT = 5;
export const MAX_BODY_SIZE = 100_000; // 100KB
export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_MESSAGES = 50;
export const MAX_RESPONSE_SIZE = 100_000; // 100KB
export const FETCH_TIMEOUT_MS = 15_000;

/** Free tier model allowlist — BYOK users can use any model */
export const FREE_MODEL_ALLOWLIST = ["claude-sonnet-4-20250514"];

/** Tier-aware limits for all authentication modes */
export const TIER_LIMITS = {
  free: { maxBody: 100_000, maxMsgLen: 10_000, maxMsgs: 50, maxTokens: 4096, dailyLimit: 50 },
  pro: { maxBody: 500_000, maxMsgLen: 50_000, maxMsgs: 100, maxTokens: 8192, dailyLimit: 500 },
  byok: {
    maxBody: 1_000_000,
    maxMsgLen: 200_000,
    maxMsgs: 200,
    maxTokens: 0,
    dailyLimit: Infinity,
  },
  anonymous: { maxBody: 100_000, maxMsgLen: 10_000, maxMsgs: 50, maxTokens: 4096, dailyLimit: 5 },
} as const;

export type TierName = keyof typeof TIER_LIMITS;

/** Payload embedded in relay-signed proxy tokens */
export interface ProxyTokenPayload {
  /** Motebit ID */
  mid: string;
  /** Tier name */
  tier: string;
  /** Daily request limit */
  lim: number;
  /** Allowed model identifiers */
  models: string[];
  /** Max tokens per request */
  mtk: number;
  /** Issued-at timestamp (ms) */
  iat: number;
  /** Expiry timestamp (ms) */
  exp: number;
}

const PROD_ORIGINS = ["https://motebit.com", "https://www.motebit.com"];
const DEV_ORIGINS = ["http://localhost:3000", "http://localhost:3002", "http://localhost:5173"];

export function getAllowedOrigins(isDev: boolean): Set<string> {
  return new Set([...PROD_ORIGINS, ...(isDev ? DEV_ORIGINS : [])]);
}

// --- CORS ---

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key, x-proxy-token, anthropic-version",
    "Access-Control-Max-Age": "86400",
  };
}

export function isAllowedOrigin(origin: string, allowedOrigins: Set<string>): boolean {
  return allowedOrigins.has(origin);
}

// --- Proxy Token ---

/** Base64url decode (no padding) → Uint8Array */
function base64urlDecode(s: string): Uint8Array {
  // Restore standard base64
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(pad);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Parse and verify a relay-signed proxy token.
 * Returns decoded payload if valid, null otherwise.
 *
 * Token format: base64url(payload_json).base64url(ed25519_signature)
 * Signature covers the raw payload bytes (UTF-8 JSON).
 */
export async function parseProxyToken(
  tokenStr: string,
  relayPublicKeyHex: string,
): Promise<ProxyTokenPayload | null> {
  try {
    const dotIndex = tokenStr.indexOf(".");
    if (dotIndex === -1) return null;

    const payloadB64 = tokenStr.slice(0, dotIndex);
    const sigB64 = tokenStr.slice(dotIndex + 1);

    const payloadBytes = base64urlDecode(payloadB64);
    const sigBytes = base64urlDecode(sigB64);

    // Decode public key from hex
    const pubKeyBytes = new Uint8Array(
      relayPublicKeyHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
    );

    // Dynamic import — works in Edge Runtime
    const ed = await import("@noble/ed25519");
    const valid = await ed.verifyAsync(sigBytes, payloadBytes, pubKeyBytes);
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as ProxyTokenPayload;

    // Check expiry
    if (payload.exp <= Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

// --- Request Validation ---

export function getClientIP(request: { headers: { get(name: string): string | null } }): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

export interface MessageValidation {
  valid: boolean;
  error?: string;
  status?: number;
}

export function validateModel(model: unknown, isBYOK: boolean): MessageValidation {
  if (!model || typeof model !== "string") {
    return { valid: false, error: "invalid_model", status: 400 };
  }
  if (!isBYOK && !FREE_MODEL_ALLOWLIST.includes(model)) {
    return {
      valid: false,
      error: `Free tier model must be one of: ${FREE_MODEL_ALLOWLIST.join(", ")}. Add your own API key for other models.`,
      status: 400,
    };
  }
  return { valid: true };
}

export function validateMessages(messages: unknown): MessageValidation {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { valid: false, error: "invalid_messages", status: 400 };
  }
  if (messages.length > MAX_MESSAGES) {
    return { valid: false, error: `too_many_messages: max ${MAX_MESSAGES}`, status: 400 };
  }
  for (const msg of messages) {
    if (
      typeof msg === "object" &&
      msg !== null &&
      "content" in msg &&
      typeof (msg as { content: unknown }).content === "string" &&
      (msg as { content: string }).content.length > MAX_MESSAGE_LENGTH
    ) {
      return { valid: false, error: "message_too_long", status: 400 };
    }
  }
  return { valid: true };
}

export function validateFetchUrl(url: unknown): MessageValidation {
  if (!url || typeof url !== "string") {
    return { valid: false, error: "missing url", status: 400 };
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { valid: false, error: "invalid url scheme", status: 400 };
  }
  return { valid: true };
}

/**
 * Build the proxied request body for the Anthropic Messages API.
 * Accepts explicit limits for tier-aware clamping.
 * Free/anonymous: clamp max_tokens, strip tools.
 * Pro: clamp max_tokens to tier limit, strip tools.
 * BYOK: pass through max_tokens and tools.
 */
export function buildProxiedBody(
  body: Record<string, unknown>,
  isBYOK: boolean,
  opts?: { maxTokens?: number },
): Record<string, unknown> {
  const defaultMax = 4096;
  let maxTokens: number;
  if (isBYOK) {
    maxTokens = (body.max_tokens as number) || defaultMax;
  } else if (opts?.maxTokens) {
    maxTokens = Math.min((body.max_tokens as number) || opts.maxTokens, opts.maxTokens);
  } else {
    maxTokens = Math.min((body.max_tokens as number) || defaultMax, defaultMax);
  }

  const proxied: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
    system: body.system,
    max_tokens: maxTokens,
    temperature: body.temperature,
    stream: true,
  };
  if (isBYOK && body.tools != null) {
    proxied.tools = body.tools;
  }
  return proxied;
}

/**
 * Strip HTML tags, scripts, and styles from raw text.
 * Used by the fetch proxy to return clean text content.
 */
export function stripHtml(text: string): string {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
