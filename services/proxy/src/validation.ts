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

/** Anonymous model allowlist — only used if anonymous proxy access is ever re-enabled */
export const FREE_MODEL_ALLOWLIST = ["claude-sonnet-4-20250514"];

/** Request limits for deposit users (generous — they pay per-token) */
export const DEPOSIT_LIMITS = {
  maxBody: 1_000_000,
  maxMsgLen: 100_000,
  maxMsgs: 200,
  maxTokens: 16384,
} as const;

/** Request limits for BYOK users (their own API key, their own limits) */
export const BYOK_LIMITS = {
  maxBody: 1_000_000,
  maxMsgLen: 200_000,
  maxMsgs: 200,
  maxTokens: 0, // no cap — user's key
} as const;

/** Payload embedded in relay-signed proxy tokens */
export interface ProxyTokenPayload {
  /** Motebit ID */
  mid: string;
  /** Balance in micro-units (1 USD = 1,000,000) */
  bal: number;
  /** Allowed model identifiers */
  models: string[];
  /** Unique token ID (nonce) */
  jti: string;
  /** Issued-at timestamp (ms) */
  iat: number;
  /** Expiry timestamp (ms) */
  exp: number;
}

// ── Provider routing ────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "google";

/** Model → provider mapping + pricing (USD per million tokens) */
const MODEL_CONFIG: Record<string, { provider: Provider; input: number; output: number }> = {
  // Anthropic
  "claude-sonnet-4-20250514": { provider: "anthropic", input: 3.0, output: 15.0 },
  "claude-opus-4-20250115": { provider: "anthropic", input: 15.0, output: 75.0 },
  "claude-haiku-4-5-20251001": { provider: "anthropic", input: 1.0, output: 5.0 },
  // OpenAI
  "gpt-4o": { provider: "openai", input: 2.5, output: 10.0 },
  "gpt-4o-mini": { provider: "openai", input: 0.15, output: 0.6 },
  // Google
  "gemini-2.5-pro": { provider: "google", input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { provider: "google", input: 0.15, output: 0.6 },
};

/**
 * Legacy and class-level model aliases → current canonical model ID.
 *
 * Frontends send whatever model string they were built with. The proxy
 * resolves it here. When a new model version ships, update the right-hand
 * side — every deployed client gets the upgrade without a redeploy.
 */
const MODEL_ALIASES: Record<string, string> = {
  // Class aliases — "give me the best Sonnet" without caring about the date suffix
  "claude-sonnet": "claude-sonnet-4-20250514",
  "claude-opus": "claude-opus-4-20250115",
  "claude-haiku": "claude-haiku-4-5-20251001",

  // Legacy dated versions → current
  "claude-3-5-sonnet-20241022": "claude-sonnet-4-20250514",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5-20251001",
  "claude-3-opus-20240229": "claude-opus-4-20250115",

  // OpenAI aliases
  "gpt-4o-2024-11-20": "gpt-4o",
  "gpt-4o-mini-2024-07-18": "gpt-4o-mini",

  // Google aliases
  "gemini-pro": "gemini-2.5-pro",
  "gemini-flash": "gemini-2.5-flash",
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-flash": "gemini-2.5-flash",
};

/** Resolve a model string to its canonical ID. Passthrough if already canonical or unknown. */
export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

/** The classifier model used for auto-routing. Cheapest available. */
export const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

/** Model recommendations by task type. */
const TASK_MODEL_MAP: Record<string, string> = {
  quick: "claude-haiku-4-5-20251001",
  chat: "claude-sonnet-4-20250514",
  reasoning: "claude-opus-4-20250115",
  code: "gpt-4o",
  research: "gemini-2.5-pro",
  creative: "claude-sonnet-4-20250514",
  math: "claude-opus-4-20250115",
};

/** Default model when classifier fails or returns unknown type. */
export const AUTO_DEFAULT_MODEL = "claude-sonnet-4-20250514";

/** Estimated output tokens for a typical response — used for pre-flight cost checks. */
const ESTIMATED_OUTPUT_TOKENS = 1000;
/** Estimated input tokens for a typical message context. */
const ESTIMATED_INPUT_TOKENS = 500;

/**
 * Pick the best model the balance can afford for a task type.
 * Tries the recommended model first; if estimated cost exceeds balance,
 * walks down a cheaper fallback chain.
 */
export function getAffordableModelForTask(taskType: string, balanceMicro: number): string {
  const preferred = TASK_MODEL_MAP[taskType] ?? AUTO_DEFAULT_MODEL;
  if (balanceMicro <= 0) return CLASSIFIER_MODEL;

  const cost = calculateCostMicro(preferred, ESTIMATED_INPUT_TOKENS, ESTIMATED_OUTPUT_TOKENS);
  if (cost <= balanceMicro) return preferred;

  // Walk down the fallback chain: Sonnet → Haiku
  for (const fallback of FALLBACK_CHAIN) {
    const fbCost = calculateCostMicro(fallback, ESTIMATED_INPUT_TOKENS, ESTIMATED_OUTPUT_TOKENS);
    if (fbCost <= balanceMicro) return fallback;
  }

  // Even Haiku is too expensive — return Haiku anyway (debit will absorb the small overrun)
  return CLASSIFIER_MODEL;
}

/** Cheapest-first fallback chain for auto-routing when balance is low. */
const FALLBACK_CHAIN = [AUTO_DEFAULT_MODEL, CLASSIFIER_MODEL];

/** Get the recommended model for a task type (no balance check). */
export function getModelForTaskType(taskType: string): string {
  return TASK_MODEL_MAP[taskType] ?? AUTO_DEFAULT_MODEL;
}

/** Get the provider for a model. */
export function getModelProvider(model: string): Provider | null {
  return MODEL_CONFIG[model]?.provider ?? null;
}

/** Get all supported model IDs. */
export function getSupportedModels(): string[] {
  return Object.keys(MODEL_CONFIG);
}

const MARGIN = 0.2; // 20% markup
const MICRO = 1_000_000;

/** Calculate cost in micro-units for a completed request. */
export function calculateCostMicro(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const config = MODEL_CONFIG[model];
  if (!config) return 0;
  const rawCost =
    (inputTokens / 1_000_000) * config.input + (outputTokens / 1_000_000) * config.output;
  return Math.ceil(rawCost * (1 + MARGIN) * MICRO);
}

const PROD_ORIGINS = ["https://motebit.com", "https://www.motebit.com"];
const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:5173",
];

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
