/**
 * Pure validation functions extracted from edge route handlers.
 * No I/O, no edge runtime dependencies — testable in any environment.
 */

import { verifyBySuite } from "@motebit/crypto/suite-dispatch";
import type { InferenceHost, ModelLab, Jurisdiction, TaskShape } from "@motebit/protocol";
import { REFERENCE_ROUTING_POLICY } from "@motebit/policy";

// Re-export the lifted unions for back-compat with proxy-internal
// callers. The canonical home is `@motebit/protocol/src/routing.ts`;
// this re-export keeps the existing `import { InferenceHost } from
// "./validation"` paths working without churn. New code should
// import from `@motebit/protocol` directly.
export type { InferenceHost, ModelLab, Jurisdiction, TaskShape };

// --- Constants ---

export const DAILY_LIMIT = 5;
export const MAX_BODY_SIZE = 100_000; // 100KB
export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_MESSAGES = 50;
export const MAX_RESPONSE_SIZE = 100_000; // 100KB
export const FETCH_TIMEOUT_MS = 15_000;

/** Anonymous model allowlist — only used if anonymous proxy access is ever re-enabled */
export const FREE_MODEL_ALLOWLIST = ["claude-sonnet-4-6"];

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

// ── Intelligence-source agility ──────────────────────────────────────────
//
// `InferenceHost`, `ModelLab`, `Jurisdiction` lifted to
// `@motebit/protocol/src/routing.ts` (Apache-2.0). The 5/13 commit
// established the role/predicate distinction; this PR lands the
// canonical home in protocol so the auto-router primitive
// (`@motebit/policy::dispatchRouting`) can consume the same types.
// Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md`.
//
// Re-exported above for proxy-internal back-compat. New code
// imports from `@motebit/protocol` directly.

/** Jurisdictions motebit-cloud (services/proxy) routes to. The earlier
 *  "DeepSeek is BYOK-only because Chinese-hosted" decision is now a typed
 *  predicate, not tribal knowledge — adding a non-US host to MODEL_CONFIG
 *  fails admission until this set is intentionally widened. */
export const MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS: ReadonlySet<Jurisdiction> = new Set<Jurisdiction>(
  ["US"],
);

interface ModelEntry {
  /** Where requests route. Same value drives pricing tier + transparency disclosure. */
  host: InferenceHost;
  /** Who trained the weights. Data field — populated for legibility, no shipping
   *  consumer today (Path C auto-routing + UI attribution would be future consumers). */
  lab: ModelLab;
  /** Legal locus of the host. Drives MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS predicate. */
  jurisdiction: Jurisdiction;
  /** Input price (USD per million tokens). */
  input: number;
  /** Output price (USD per million tokens). */
  output: number;
}

/** Model → entry mapping. Three tiers per vertically-integrated lab+host
 *  pair (Anthropic, OpenAI, Google); Groq adds 2 open-source rows where
 *  host !== lab — the structural proof that the axes are decoupled. */
const MODEL_CONFIG: Record<string, ModelEntry> = {
  // Anthropic — opus (strongest), sonnet (default), haiku (fast). Vertically
  // integrated: host === lab (Anthropic trains AND hosts Claude).
  "claude-opus-4-6": {
    host: "anthropic",
    lab: "anthropic",
    jurisdiction: "US",
    input: 5.0,
    output: 25.0,
  },
  "claude-sonnet-4-6": {
    host: "anthropic",
    lab: "anthropic",
    jurisdiction: "US",
    input: 3.0,
    output: 15.0,
  },
  "claude-haiku-4-5-20251001": {
    host: "anthropic",
    lab: "anthropic",
    jurisdiction: "US",
    input: 1.0,
    output: 5.0,
  },
  // OpenAI — gpt-5.4 (strongest), gpt-5.4-mini (mid), gpt-5.4-nano (fast).
  // Vertically integrated for hosted models; OpenAI also appears as `lab`
  // for gpt-oss-120b below (open-source) running on Groq.
  "gpt-5.4": { host: "openai", lab: "openai", jurisdiction: "US", input: 2.5, output: 15.0 },
  "gpt-5.4-mini": {
    host: "openai",
    lab: "openai",
    jurisdiction: "US",
    input: 0.75,
    output: 4.5,
  },
  "gpt-5.4-nano": {
    host: "openai",
    lab: "openai",
    jurisdiction: "US",
    input: 0.2,
    output: 1.25,
  },
  // Google — 2.5 pro (strongest), 2.5 flash (default), 2.5 flash-lite (fast).
  // Pro has tiered pricing (>200k: $2.50/$15). Using ≤200k rate; acceptable margin risk.
  "gemini-2.5-pro": {
    host: "google",
    lab: "google",
    jurisdiction: "US",
    input: 1.25,
    output: 10.0,
  },
  "gemini-2.5-flash": {
    host: "google",
    lab: "google",
    jurisdiction: "US",
    input: 0.3,
    output: 2.5,
  },
  "gemini-2.5-flash-lite": {
    host: "google",
    lab: "google",
    jurisdiction: "US",
    input: 0.1,
    output: 0.4,
  },
  // Groq — open-source weights on LPU hardware. host !== lab for both:
  // Meta trained Llama; OpenAI released gpt-oss-120b as open weights;
  // Groq runs them. Speed advantage (~500 tok/s on 70B vs ~50-80 on
  // standard GPU clouds) compounds across motebit's tool-call-heavy loops.
  "llama-3.3-70b-versatile": {
    host: "groq",
    lab: "meta",
    jurisdiction: "US",
    input: 0.59,
    output: 0.79,
  },
  "openai/gpt-oss-120b": {
    host: "groq",
    lab: "openai",
    jurisdiction: "US",
    input: 0.15,
    output: 0.75,
  },
};

/**
 * Legacy and class-level model aliases → current canonical model ID.
 *
 * Frontends send whatever model string they were built with. The proxy
 * resolves it here. When a new model version ships, update the right-hand
 * side — every deployed client gets the upgrade without a redeploy.
 */
const MODEL_ALIASES: Record<string, string> = {
  // Class aliases — "give me the best Sonnet" without caring about the version
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus": "claude-opus-4-6",
  "claude-haiku": "claude-haiku-4-5-20251001",

  // Legacy dated versions → current
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "claude-opus-4-20250115": "claude-opus-4-6",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4-6",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5-20251001",
  "claude-3-opus-20240229": "claude-opus-4-6",

  // OpenAI aliases
  "gpt-5": "gpt-5.4",
  "gpt-4o": "gpt-5.4-mini",
  "gpt-4o-mini": "gpt-5.4-nano",
  "gpt-4o-2024-11-20": "gpt-5.4-mini",
  "gpt-4o-mini-2024-07-18": "gpt-5.4-nano",

  // Google aliases
  "gemini-pro": "gemini-2.5-pro",
  "gemini-flash": "gemini-2.5-flash",
  "gemini-flash-lite": "gemini-2.5-flash-lite",
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-flash": "gemini-2.5-flash",
};

/** Resolve a model string to its canonical ID. Passthrough if already canonical or unknown. */
export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

/** The classifier model used for auto-routing. Must be an Anthropic model (classifyTask calls Anthropic API). */
export const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

/** Cheapest model across all providers — used as last-resort fallback when balance is near zero. */
export const CHEAPEST_MODEL = "gemini-2.5-flash-lite";

/**
 * Model recommendations by task type — alias to the canonical
 * `REFERENCE_ROUTING_POLICY` lifted to `@motebit/policy`. The proxy
 * historically held the source-of-truth here; PR-1 of the auto-router
 * makes the policy a protocol-layer primitive consumed via
 * `dispatchRouting`. This local alias preserves the proxy-internal
 * callsites (`getModelForTaskType`, `getAffordableModelForTask`)
 * during the lift; new code consumes `REFERENCE_ROUTING_POLICY` and
 * `dispatchRouting` from `@motebit/policy` directly.
 */
const TASK_MODEL_MAP: Readonly<Record<string, string>> = REFERENCE_ROUTING_POLICY;

/** Default model when classifier fails or returns unknown type. */
export const AUTO_DEFAULT_MODEL = "claude-sonnet-4-6";

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
  if (balanceMicro <= 0) return CHEAPEST_MODEL;

  const cost = calculateCostMicro(preferred, ESTIMATED_INPUT_TOKENS, ESTIMATED_OUTPUT_TOKENS);
  if (cost <= balanceMicro) return preferred;

  // Walk down the fallback chain: Sonnet → Haiku → Flash-Lite
  for (const fallback of FALLBACK_CHAIN) {
    const fbCost = calculateCostMicro(fallback, ESTIMATED_INPUT_TOKENS, ESTIMATED_OUTPUT_TOKENS);
    if (fbCost <= balanceMicro) return fallback;
  }

  // Even Flash-Lite is too expensive — return it anyway (debit will absorb the small overrun)
  return CHEAPEST_MODEL;
}

/** Fallback chain for auto-routing when balance is low: Sonnet → Haiku → Flash-Lite. */
const FALLBACK_CHAIN = [AUTO_DEFAULT_MODEL, CLASSIFIER_MODEL, CHEAPEST_MODEL];

/** Get the recommended model for a task type (no balance check). */
export function getModelForTaskType(taskType: string): string {
  return TASK_MODEL_MAP[taskType] ?? AUTO_DEFAULT_MODEL;
}

/** Get the inference host for a model. Returns null for unknown models. */
export function getModelHost(model: string): InferenceHost | null {
  return MODEL_CONFIG[model]?.host ?? null;
}

/**
 * Return the proxy's model catalog as `ProviderCapability[]` for
 * `dispatchRouting`. Translates the proxy-internal `ModelEntry`
 * shape (`input`/`output`) to the canonical `ProviderCapability`
 * shape (`inputCostPerMillion`/`outputCostPerMillion`) from
 * `@motebit/protocol`. Catalog ordering is preserved — the
 * dispatcher honors order as the consumer's preference signal.
 *
 * Note: returning a fresh array each call is acceptable for the
 * proxy's edge-runtime call rate; if hot-path perf demands, this
 * could memoize at module load.
 */
export function getProviderCatalog(): import("@motebit/protocol").ProviderCapability[] {
  return Object.entries(MODEL_CONFIG).map(([modelName, entry]) => ({
    modelName,
    host: entry.host,
    lab: entry.lab,
    jurisdiction: entry.jurisdiction,
    inputCostPerMillion: entry.input,
    outputCostPerMillion: entry.output,
  }));
}

/** Backwards-compatible alias preserved for callers that imported the
 *  pre-axis-split name. New code should call `getModelHost` directly —
 *  the function returns the data-flow destination, not the lab. */
export const getModelProvider = getModelHost;

/** Get the model lab (who trained the weights). Data-field accessor —
 *  populated for legibility; no shipping consumer today (Path C auto-routing
 *  + UI attribution would be future consumers). Returns null for unknown models. */
export function getModelLab(model: string): ModelLab | null {
  return MODEL_CONFIG[model]?.lab ?? null;
}

/** Get the legal jurisdiction of the model's inference host. Returns null
 *  for unknown models. Consumers: motebit-cloud admission predicate. */
export function getModelJurisdiction(model: string): Jurisdiction | null {
  return MODEL_CONFIG[model]?.jurisdiction ?? null;
}

/** Motebit-cloud admission predicate. Returns true iff the model is known
 *  AND its host's jurisdiction is in `MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS`.
 *  Previously this was tribal knowledge ("we just didn't add DeepSeek to
 *  motebit-cloud because it's Chinese-hosted") — now it's structural.
 *  BYOK mode skips this check entirely (the user's own key, the user's own
 *  choice; sovereignty doctrine stays orthogonal to tier policy). */
export function isModelAllowedInMotebitCloud(model: string): boolean {
  const jurisdiction = getModelJurisdiction(model);
  return jurisdiction != null && MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS.has(jurisdiction);
}

/** Get all supported model IDs. */
export function getSupportedModels(): string[] {
  return Object.keys(MODEL_CONFIG);
}

const MARGIN = 0.2; // 20% markup
const MICRO = 1_000_000;

/** Calculate cost in micro-units for a completed request.
 *
 *  Anthropic usage fields are disjoint buckets (not overlapping):
 *    input_tokens          = non-cached tokens (after last cache breakpoint)
 *    cache_read_input_tokens    = cached tokens read from cache (0.1x price)
 *    cache_creation_input_tokens = tokens written to cache (1.25x price)
 *    total_input = input_tokens + cache_read + cache_creation
 */
export function calculateCostMicro(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  const config = MODEL_CONFIG[model];
  if (!config) return 0;
  const rawCost =
    (inputTokens / 1_000_000) * config.input +
    (cacheReadTokens / 1_000_000) * config.input * 0.1 +
    (cacheCreationTokens / 1_000_000) * config.input * 1.25 +
    (outputTokens / 1_000_000) * config.output;
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

    // The relay signs ProxyToken payloads by applying JCS to the
    // payload JSON and Ed25519-signing those bytes; the envelope
    // encodes both sides as base64url. That matches
    // `motebit-jcs-ed25519-b64-v1`. ProxyToken is service-local (no
    // on-wire `suite` field — it is not a protocol artifact), so the
    // suite is named here at the verify call. If the relay ever
    // switches signing suites, this constant moves with it.
    const valid = await verifyBySuite(
      "motebit-jcs-ed25519-b64-v1",
      payloadBytes,
      sigBytes,
      pubKeyBytes,
    );
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

// Sibling of the inline decoder in `packages/tools/src/builtins/read-url.ts`.
// Two engines, same intent — keep the entity tables aligned in the same pass.
// `nbsp` decodes to U+0020 so the whitespace-collapse step downstream
// treats it uniformly across runtimes; unknown entities pass through
// verbatim so a stray "&" never breaks a fetch.
const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) {
      const code = parseInt(ref.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (ref.startsWith("#")) {
      const code = parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return HTML_NAMED_ENTITIES[ref] ?? match;
  });
}

/**
 * Strip HTML tags, scripts, and styles from raw text and decode the
 * entities (`&nbsp;`, `&copy;`, numeric `&#NN;` / `&#xHH;`) the model
 * would otherwise see as escape codes. Used by the fetch proxy to return
 * clean prose to the AI.
 */
export function stripHtml(text: string): string {
  return decodeHtmlEntities(
    text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s{2,}/g, " ")
    .trim();
}
