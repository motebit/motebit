export const runtime = "edge";

import {
  type ProxyTokenPayload,
  type Provider,
  DEPOSIT_LIMITS,
  BYOK_LIMITS,
  parseProxyToken,
  calculateCostMicro,
  getModelProvider,
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

export function OPTIONS(request: Request): Response {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/** Fire-and-forget debit call to the relay. */
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
  }).catch(() => {});
}

// ── Provider API adapters ───────────────────────────────────────────────

function getProviderApiKey(provider: Provider): string | null {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ?? null;
    case "openai":
      return process.env.OPENAI_API_KEY ?? null;
    case "google":
      return process.env.GOOGLE_AI_API_KEY ?? null;
  }
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Build the provider-specific request. All providers receive the same logical input. */
function buildProviderRequest(
  provider: Provider,
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  maxTokensCap: number,
): ProviderRequest {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const system = body.system as string | undefined;
  const maxTokens =
    maxTokensCap > 0
      ? Math.min((body.max_tokens as number) || maxTokensCap, maxTokensCap)
      : (body.max_tokens as number) || 4096;

  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          messages,
          system,
          max_tokens: maxTokens,
          temperature: body.temperature,
          stream: true,
          ...(body.tools != null ? { tools: body.tools } : {}),
        }),
      };

    case "openai": {
      // OpenAI format: system is a message, not a separate field
      const openaiMessages = system ? [{ role: "system", content: system }, ...messages] : messages;
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: openaiMessages,
          max_tokens: maxTokens,
          temperature: body.temperature,
          stream: true,
          stream_options: { include_usage: true },
          ...(body.tools != null ? { tools: body.tools } : {}),
        }),
      };
    }

    case "google": {
      // Google AI uses OpenAI-compatible endpoint
      const geminiMessages = system ? [{ role: "system", content: system }, ...messages] : messages;
      return {
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: geminiMessages,
          max_tokens: maxTokens,
          temperature: body.temperature,
          stream: true,
          stream_options: { include_usage: true },
        }),
      };
    }
  }
}

/** Extract token usage from a streaming SSE chunk. Handles both Anthropic and OpenAI formats. */
function extractUsage(
  provider: Provider,
  line: string,
  usage: { input: number; output: number },
): void {
  if (!line.startsWith("data: ")) return;
  const json = line.slice(6);
  if (json === "[DONE]") return;
  try {
    const evt = JSON.parse(json) as Record<string, unknown>;

    if (provider === "anthropic") {
      // Anthropic: initial message has usage.input_tokens, message_delta has usage.output_tokens
      const u = evt.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      if (u?.input_tokens != null) usage.input = u.input_tokens;
      if (u?.output_tokens != null) usage.output = u.output_tokens;
    } else {
      // OpenAI / Google: final chunk has usage object
      const u = evt.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (u?.prompt_tokens != null) usage.input = u.prompt_tokens;
      if (u?.completion_tokens != null) usage.output = u.completion_tokens;
    }
  } catch {
    // Not valid JSON — ignore
  }
}

// ── Main handler ────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cors = corsHeaders(origin);

  // --- Authentication ---
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

    if (tokenPayload.bal <= 0) {
      return new Response(
        JSON.stringify({
          error: "insufficient_balance",
          message: "Deposit funds to use cloud AI.",
          balance: 0,
        }),
        { status: 402, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    authMode = "proxy-token";
  } else {
    return new Response(
      JSON.stringify({ error: "unauthorized", message: "Provide a proxy token or API key." }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const isBYOK = authMode === "byok";
  const limits = isBYOK ? BYOK_LIMITS : DEPOSIT_LIMITS;

  // --- Parse body ---
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
          message: `Allowed: ${tokenPayload.models.join(", ")}`,
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
  }

  // --- Resolve provider and API key ---
  const provider = getModelProvider(requestedModel);

  let apiKey: string | null;
  if (isBYOK) {
    // BYOK: user's key goes to Anthropic (default) or detected provider
    apiKey = clientApiKey;
  } else {
    if (!provider) {
      return new Response(
        JSON.stringify({
          error: "invalid_model",
          message: `Model not supported: ${requestedModel}`,
        }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
    apiKey = getProviderApiKey(provider);
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: "provider_not_configured",
          message: `${provider} is not configured on this proxy`,
        }),
        { status: 501, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
  }

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "server_error", message: "No API key available" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
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

  // --- Build and send provider request ---
  const resolvedProvider = provider ?? "anthropic"; // BYOK defaults to Anthropic
  const providerReq = buildProviderRequest(
    resolvedProvider,
    apiKey,
    requestedModel,
    body,
    limits.maxTokens,
  );
  const requestId = crypto.randomUUID();

  const providerRes = await fetch(providerReq.url, {
    method: "POST",
    headers: providerReq.headers,
    body: providerReq.body,
  });

  // --- Stream response and extract usage for debit ---
  if (authMode === "proxy-token" && tokenPayload && providerRes.ok && providerRes.body) {
    const mid = tokenPayload.mid;
    const model = requestedModel;
    const prov = resolvedProvider;
    const usage = { input: 0, output: 0 };

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const reader = providerRes.body.getReader();
    const decoder = new TextDecoder();

    void (async () => {
      try {
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            extractUsage(prov, line, usage);
          }
        }
      } finally {
        await writer.close();
        const cost = calculateCostMicro(model, usage.input, usage.output);
        if (cost > 0) debitRelay(mid, cost, requestId);
      }
    })();

    return new Response(readable, {
      status: providerRes.status,
      headers: {
        ...cors,
        "Content-Type": providerRes.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }

  // BYOK or non-streaming: pipe directly
  return new Response(providerRes.body, {
    status: providerRes.status,
    headers: {
      ...cors,
      "Content-Type": providerRes.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
