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
    "Access-Control-Allow-Headers": "Content-Type, x-api-key, anthropic-version",
    "Access-Control-Max-Age": "86400",
  };
}

export function isAllowedOrigin(origin: string, allowedOrigins: Set<string>): boolean {
  return allowedOrigins.has(origin);
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
 * Free tier: clamp max_tokens to 4096, strip tools.
 * BYOK: pass through max_tokens and tools.
 */
export function buildProxiedBody(
  body: Record<string, unknown>,
  isBYOK: boolean,
): Record<string, unknown> {
  const proxied: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
    system: body.system,
    max_tokens: isBYOK
      ? (body.max_tokens as number) || 4096
      : Math.min((body.max_tokens as number) || 4096, 4096),
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
