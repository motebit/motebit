export const runtime = "edge";

import {
  type ProxyTokenPayload,
  type TierName,
  TIER_LIMITS,
  parseProxyToken,
} from "../../../validation";

// Free tier model allowlist — BYOK users can use any model
const FREE_MODEL_ALLOWLIST = ["claude-haiku-4-5-20251001"];

// Tier → Anthropic model mapping (proxy-token users get the model for their tier)
const TIER_MODEL_MAP: Record<string, string> = {
  free: "claude-haiku-4-5-20251001",
  pro: "claude-sonnet-4-20250514",
  anonymous: "claude-haiku-4-5-20251001",
};

const ALLOWED_ORIGINS = new Set([
  "https://motebit.com",
  "https://www.motebit.com",
  // Localhost is safe — the proxy validates API keys regardless of origin
  "http://localhost:3000",
  "http://localhost:3002",
  "http://localhost:5173",
]);

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key, x-proxy-token, anthropic-version",
    "Access-Control-Max-Age": "86400",
  };
}

function getClientIP(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

async function checkRateLimit(
  key: string,
  dailyLimit: number,
): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const { kv } = await import("@vercel/kv");
    const count = await kv.incr(key);
    if (count === 1) {
      await kv.expire(key, 86400);
    }
    return {
      allowed: count <= dailyLimit,
      remaining: Math.max(0, dailyLimit - count),
    };
  } catch {
    // KV unavailable — fail closed, deny the request
    return { allowed: false, remaining: 0 };
  }
}

async function recordUsage(motebitId: string): Promise<void> {
  try {
    const { kv } = await import("@vercel/kv");
    const key = `proxy:usage:${motebitId}:${currentMonth()}`;
    const count = await kv.incr(key);
    if (count === 1) {
      // Expire after 90 days — enough for billing reconciliation
      await kv.expire(key, 90 * 86400);
    }
  } catch {
    // Best-effort usage tracking — don't fail the request
  }
}

// OPTIONS — CORS preflight
export function OPTIONS(request: Request): Response {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// POST — proxy to Anthropic Messages API
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cors = corsHeaders(origin);

  // --- Authentication: three modes ---
  // 1. Proxy token (relay-signed, contains tier)
  // 2. BYOK (user's own API key)
  // 3. Anonymous (IP-based rate limiting)

  const proxyTokenStr = request.headers.get("x-proxy-token");
  const clientApiKey = request.headers.get("x-api-key");

  let authMode: "proxy-token" | "byok" | "anonymous";
  let tokenPayload: ProxyTokenPayload | null = null;
  let tierName: TierName = "anonymous";

  if (clientApiKey != null && clientApiKey !== "") {
    // Mode 1: BYOK — user's own API key always takes precedence
    authMode = "byok";
    tierName = "byok";
  } else if (proxyTokenStr) {
    // Mode 2: Proxy token — verify signature and extract tier
    const relayPubKey = process.env.RELAY_PUBLIC_KEY;
    if (!relayPubKey) {
      return new Response(
        JSON.stringify({
          error: "server_error",
          message: "Proxy token verification not configured",
        }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    tokenPayload = await parseProxyToken(proxyTokenStr, relayPubKey);
    if (!tokenPayload) {
      return new Response(
        JSON.stringify({ error: "invalid_token", message: "Invalid or expired proxy token" }),
        { status: 401, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    authMode = "proxy-token";
    tierName = (tokenPayload.tier in TIER_LIMITS ? tokenPayload.tier : "free") as TierName;
  } else {
    // Mode 3: Anonymous — IP-based rate limiting
    authMode = "anonymous";
    tierName = "anonymous";
  }

  const isBYOK = authMode === "byok";
  const limits = TIER_LIMITS[tierName];

  // Resolve API key
  const apiKey = isBYOK ? clientApiKey! : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "server_error", message: "Proxy not configured" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  // --- Rate limiting ---
  if (authMode === "proxy-token" && tokenPayload) {
    // Keyed by motebit ID + date
    const key = `proxy:sub:${tokenPayload.mid}:${todayDate()}`;
    const dailyLimit = limits.dailyLimit; // Use tier config, not token payload
    const { allowed } = await checkRateLimit(key, dailyLimit);
    if (!allowed) {
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          message: `You've used your ${dailyLimit} daily messages. Upgrade your tier or try again tomorrow.`,
          remaining: 0,
        }),
        {
          status: 429,
          headers: {
            ...cors,
            "Content-Type": "application/json",
            "Retry-After": "86400",
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }
    // Also count against IP limit to prevent token→anonymous evasion
    const ip = getClientIP(request);
    void checkRateLimit(`proxy:${ip}:${todayDate()}`, TIER_LIMITS.anonymous.dailyLimit).catch(
      () => {},
    );
  } else if (authMode === "anonymous") {
    // IP-based rate limiting (backward compatible)
    const ip = getClientIP(request);
    const key = `proxy:${ip}:${todayDate()}`;
    const { allowed } = await checkRateLimit(key, limits.dailyLimit);
    if (!allowed) {
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          message: `You've used your ${limits.dailyLimit} free messages today. Add your own API key in Settings for unlimited use, or try again tomorrow.`,
          remaining: 0,
        }),
        {
          status: 429,
          headers: {
            ...cors,
            "Content-Type": "application/json",
            "Retry-After": "86400",
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }
  }
  // BYOK: no rate limiting — user pays their own way

  // --- Parse and validate body ---
  const raw = await request.text();
  if (raw.length > limits.maxBody) {
    return new Response(JSON.stringify({ error: "request_too_large" }), {
      status: 413,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // --- Validate model ---
  const requestedModel = body.model as string | undefined;
  if (!requestedModel) {
    return new Response(JSON.stringify({ error: "invalid_model", message: "Model is required" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let resolvedModel = requestedModel;

  if (authMode === "proxy-token" && tokenPayload) {
    // Enforce model allowlist from token
    if (tokenPayload.models.length > 0 && !tokenPayload.models.includes(requestedModel)) {
      return new Response(
        JSON.stringify({
          error: "invalid_model",
          message: `Your tier allows: ${tokenPayload.models.join(", ")}. Upgrade for access to other models.`,
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
    // Map tier to the correct Anthropic model
    resolvedModel = TIER_MODEL_MAP[tierName] ?? requestedModel;
  } else if (!isBYOK) {
    // Anonymous: enforce free model allowlist
    if (!FREE_MODEL_ALLOWLIST.includes(requestedModel)) {
      return new Response(
        JSON.stringify({
          error: "invalid_model",
          message: `Free tier model must be one of: ${FREE_MODEL_ALLOWLIST.join(", ")}. Add your own API key for other models.`,
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
  }

  // --- Validate messages ---
  const messages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: "invalid_messages" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (messages.length > limits.maxMsgs) {
    return new Response(
      JSON.stringify({ error: "too_many_messages", message: `Max ${limits.maxMsgs} messages` }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (msg.content.length > limits.maxMsgLen) {
        return new Response(JSON.stringify({ error: "message_too_long" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      totalChars += msg.content.length;
    }
  }
  if (totalChars > limits.maxBody) {
    return new Response(JSON.stringify({ error: "payload_too_large" }), {
      status: 413,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // --- Build proxied request ---
  // Use canonical tier limits, not token payload fields
  const maxTokensCap = limits.maxTokens;

  const proxiedBody: Record<string, unknown> = {
    model: resolvedModel,
    messages: body.messages,
    system: body.system,
    max_tokens: isBYOK
      ? (body.max_tokens as number) || 4096
      : Math.min((body.max_tokens as number) || maxTokensCap, maxTokensCap),
    temperature: body.temperature,
    stream: body.stream ?? true,
  };

  // BYOK users get tool support; free/proxy-token tiers strip tools to keep costs down
  if (isBYOK && body.tools != null) {
    proxiedBody.tools = body.tools;
  }

  // --- Forward to Anthropic ---
  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(proxiedBody),
  });

  // Record usage for proxy-token requests (best-effort, non-blocking)
  if (authMode === "proxy-token" && tokenPayload) {
    // Fire-and-forget — don't await, don't block the response
    void recordUsage(tokenPayload.mid);
  }

  // Pipe Anthropic's streaming response directly to the client
  return new Response(anthropicRes.body, {
    status: anthropicRes.status,
    headers: {
      ...cors,
      "Content-Type": anthropicRes.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
