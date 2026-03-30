export const runtime = "edge";

import {
  type ProxyTokenPayload,
  DEPOSIT_LIMITS,
  BYOK_LIMITS,
  parseProxyToken,
  calculateCostMicro,
} from "../../../validation";

const ALLOWED_ORIGINS = new Set([
  "https://motebit.com",
  "https://www.motebit.com",
  "http://localhost:3000",
  "http://localhost:3001",
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

// OPTIONS — CORS preflight
export function OPTIONS(request: Request): Response {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/** Fire-and-forget debit call to the relay after serving a response. */
function debitRelay(motebitId: string, amountMicro: number, referenceId: string): void {
  const relayUrl = process.env.RELAY_API_URL ?? "https://motebit-sync.fly.dev";
  const secret = process.env.RELAY_PROXY_SECRET;
  if (!secret || amountMicro <= 0) return;

  void fetch(`${relayUrl}/api/v1/agents/${motebitId}/debit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-relay-secret": secret },
    body: JSON.stringify({
      amount: amountMicro,
      reference_id: referenceId,
      description: "Cloud AI usage",
    }),
  }).catch(() => {
    // Best-effort — the 20% margin absorbs occasional failures
  });
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

  // --- Authentication: two modes ---
  // 1. Proxy token (relay-signed, contains balance)
  // 2. BYOK (user's own API key)

  const proxyTokenStr = request.headers.get("x-proxy-token");
  const clientApiKey = request.headers.get("x-api-key");

  let authMode: "proxy-token" | "byok";
  let tokenPayload: ProxyTokenPayload | null = null;

  if (clientApiKey != null && clientApiKey !== "") {
    authMode = "byok";
  } else if (proxyTokenStr) {
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

    // Balance check — if zero, the client should fall back to local inference
    if (tokenPayload.bal <= 0) {
      return new Response(
        JSON.stringify({
          error: "insufficient_balance",
          message: "Deposit funds to use cloud AI, or switch to local inference.",
          balance: 0,
        }),
        { status: 402, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    authMode = "proxy-token";
  } else {
    // No token, no API key — denied
    return new Response(
      JSON.stringify({ error: "unauthorized", message: "Provide a proxy token or API key." }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const isBYOK = authMode === "byok";
  const limits = isBYOK ? BYOK_LIMITS : DEPOSIT_LIMITS;

  // Resolve API key
  const apiKey = isBYOK ? clientApiKey! : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "server_error", message: "Proxy not configured" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

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

  if (authMode === "proxy-token" && tokenPayload) {
    if (tokenPayload.models.length > 0 && !tokenPayload.models.includes(requestedModel)) {
      return new Response(
        JSON.stringify({
          error: "invalid_model",
          message: `Allowed models: ${tokenPayload.models.join(", ")}`,
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
  const maxTokensCap = limits.maxTokens;

  const proxiedBody: Record<string, unknown> = {
    model: requestedModel,
    messages: body.messages,
    system: body.system,
    max_tokens: isBYOK
      ? (body.max_tokens as number) || 4096
      : maxTokensCap > 0
        ? Math.min((body.max_tokens as number) || maxTokensCap, maxTokensCap)
        : (body.max_tokens as number) || 4096,
    temperature: body.temperature,
    stream: body.stream ?? true,
  };

  // BYOK users get tool support; deposit users get tools too (they're paying)
  if (body.tools != null) {
    proxiedBody.tools = body.tools;
  }

  // --- Forward to Anthropic ---
  const requestId = crypto.randomUUID();
  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(proxiedBody),
  });

  // --- Stream response and extract usage for debit ---
  if (authMode === "proxy-token" && tokenPayload && anthropicRes.ok && anthropicRes.body) {
    // Tee the stream: pass through to client while extracting the final usage event
    const model = requestedModel;
    const mid = tokenPayload.mid;
    let inputTokens = 0;
    let outputTokens = 0;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();

    // Process stream in background — zero latency to client
    void (async () => {
      try {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);

          // Accumulate SSE text to find usage in final events
          buffer += decoder.decode(value, { stream: true });

          // Parse usage from message_delta or message_stop events
          // Anthropic sends: data: {"type":"message_delta","usage":{"output_tokens":N}}
          // and the initial message has: "usage":{"input_tokens":N}
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // keep incomplete line
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6);
            if (json === "[DONE]") continue;
            try {
              const evt = JSON.parse(json) as {
                type?: string;
                usage?: { input_tokens?: number; output_tokens?: number };
              };
              if (evt.usage?.input_tokens != null) inputTokens = evt.usage.input_tokens;
              if (evt.usage?.output_tokens != null) outputTokens = evt.usage.output_tokens;
            } catch {
              // Not valid JSON — ignore
            }
          }
        }
      } finally {
        await writer.close();
        // Debit after stream completes — fire and forget
        const cost = calculateCostMicro(model, inputTokens, outputTokens);
        if (cost > 0) {
          debitRelay(mid, cost, requestId);
        }
      }
    })();

    return new Response(readable, {
      status: anthropicRes.status,
      headers: {
        ...cors,
        "Content-Type": anthropicRes.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }

  // BYOK or non-streaming: pipe directly
  return new Response(anthropicRes.body, {
    status: anthropicRes.status,
    headers: {
      ...cors,
      "Content-Type": anthropicRes.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
