export const runtime = "edge";

const DAILY_LIMIT = 5;
// Free tier: strict limits to control cost
const FREE_MAX_BODY_SIZE = 100_000; // 100KB
const FREE_MAX_MESSAGE_LENGTH = 10_000;
const FREE_MAX_MESSAGES = 50;
// BYOK: relaxed but bounded — user pays, but protect infra
const BYOK_MAX_BODY_SIZE = 1_000_000; // 1MB
const BYOK_MAX_MESSAGE_LENGTH = 200_000;
const BYOK_MAX_MESSAGES = 200;
// Free tier model allowlist — BYOK users can use any model
const FREE_MODEL_ALLOWLIST = ["claude-sonnet-4-20250514"];

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
    "Access-Control-Allow-Headers": "Content-Type, x-api-key, anthropic-version",
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

async function checkRateLimit(ip: string): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const { kv } = await import("@vercel/kv");
    const today = new Date().toISOString().slice(0, 10);
    const key = `proxy:${ip}:${today}`;
    const count = await kv.incr(key);
    if (count === 1) {
      await kv.expire(key, 86400);
    }
    return {
      allowed: count <= DAILY_LIMIT,
      remaining: Math.max(0, DAILY_LIMIT - count),
    };
  } catch {
    // KV unavailable — allow the request but mark as last free message
    // to avoid crashing the proxy when KV is not provisioned
    return { allowed: true, remaining: 0 };
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

  // Determine API key: user's own key (BYOK) or server's free-tier key
  const clientApiKey = request.headers.get("x-api-key");
  const isBYOK = clientApiKey != null && clientApiKey !== "";
  const apiKey = isBYOK ? clientApiKey : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "server_error", message: "Proxy not configured" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  // Rate limit — only for free tier, BYOK users pay their own way
  if (!isBYOK) {
    const ip = getClientIP(request);
    const { allowed } = await checkRateLimit(ip);
    if (!allowed) {
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          message: `You've used your ${DAILY_LIMIT} free messages today. Add your own API key in Settings for unlimited use, or try again tomorrow.`,
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

  // Parse and validate body — post-parse size is the true boundary
  const maxBody = isBYOK ? BYOK_MAX_BODY_SIZE : FREE_MAX_BODY_SIZE;
  const raw = await request.text();
  if (raw.length > maxBody) {
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

  // Validate model — free tier is restricted, BYOK can use any model
  const model = body.model as string | undefined;
  if (!model) {
    return new Response(JSON.stringify({ error: "invalid_model", message: "Model is required" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (!isBYOK && !FREE_MODEL_ALLOWLIST.includes(model)) {
    return new Response(
      JSON.stringify({
        error: "invalid_model",
        message: `Free tier model must be one of: ${FREE_MODEL_ALLOWLIST.join(", ")}. Add your own API key for other models.`,
      }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  // Validate messages — graduated limits by tier
  const messages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: "invalid_messages" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const maxMessages = isBYOK ? BYOK_MAX_MESSAGES : FREE_MAX_MESSAGES;
  const maxMsgLen = isBYOK ? BYOK_MAX_MESSAGE_LENGTH : FREE_MAX_MESSAGE_LENGTH;
  if (messages.length > maxMessages) {
    return new Response(
      JSON.stringify({ error: "too_many_messages", message: `Max ${maxMessages} messages` }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (msg.content.length > maxMsgLen) {
        return new Response(JSON.stringify({ error: "message_too_long" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      totalChars += msg.content.length;
    }
  }
  if (totalChars > maxBody) {
    return new Response(JSON.stringify({ error: "payload_too_large" }), {
      status: 413,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Build proxied request
  const proxiedBody: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
    system: body.system,
    max_tokens: isBYOK
      ? (body.max_tokens as number) || 4096
      : Math.min((body.max_tokens as number) || 4096, 4096),
    temperature: body.temperature,
    stream: body.stream ?? true,
  };

  // BYOK users get tool support; free tier strips tools to keep costs down
  if (isBYOK && body.tools != null) {
    proxiedBody.tools = body.tools;
  }

  // Forward to Anthropic
  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(proxiedBody),
  });

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
