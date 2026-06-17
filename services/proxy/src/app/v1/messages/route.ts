export const runtime = "edge";

import {
  type ProxyTokenPayload,
  type InferenceHost,
  isModelAllowedInMotebitCloud,
  DEPOSIT_LIMITS,
  BYOK_LIMITS,
  parseProxyToken,
  calculateCostMicro,
  getModelProvider,
  getProviderCatalog,
  resolveModelAlias,
  CLASSIFIER_MODEL,
  AUTO_DEFAULT_MODEL,
} from "../../../validation";
import { isTaskShape, type RoutingConstraint } from "@motebit/protocol";
import { dispatchRouting, applyBalanceFilter, REFERENCE_ROUTING_POLICY } from "@motebit/policy";
// Provider request shaping (incl. Anthropic prompt-caching) lives in a pure,
// unit-tested sibling module — the edge route is glue, the cost-critical request
// shape is testable on its own.
import { buildProviderRequest } from "./provider-request";
// Streaming usage extraction (pure, unit-tested) — normalizes each provider's
// token-usage shape for the cost calc, incl. OpenAI's cached_tokens split.
import { extractUsage, type UsageAccumulator } from "./usage";
// Pre-stream failure classification + the shared one-event-per-failure surface.
// Observation only (no recovery) — see `inference/classify.ts`.
import {
  classifyProviderHttpFailure,
  classifyProviderTransportFailure,
  motebitFailure,
} from "../../../inference/classify";
import { failureResponse, emitProxyFailure } from "../../../inference/failure-response";

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
    // Expose custom response headers so the browser client can read them
    // cross-origin: the per-turn trace id (failures), routing reason (success),
    // and the upstream retry guidance forwarded on a provider 429.
    "Access-Control-Expose-Headers": "X-Motebit-Request-Id, X-Motebit-Routing-Reason, Retry-After",
    "Access-Control-Max-Age": "86400",
  };
}

export function OPTIONS(request: Request): Response {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/** Classify a user message to pick the best model. Returns a task type string. */
async function classifyTask(apiKey: string, message: string): Promise<string> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 30,
        messages: [
          {
            role: "user",
            content: `Classify this message into exactly one category. Reply with ONLY the category word, nothing else.

Categories: quick (greeting, simple question), chat (conversation, opinion), reasoning (complex analysis, logic), code (programming, debugging), research (find information, compare), creative (writing, brainstorming), math (calculation, proof)

Message: ${message.slice(0, 500)}`,
          },
        ],
      }),
    });
    if (!res.ok) return "chat";
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const reply = data.content?.[0]?.text?.trim().toLowerCase() ?? "chat";
    return reply;
  } catch {
    return "chat"; // default to Sonnet on failure
  }
}

/** Fire-and-forget debit call to the relay. */
function debitRelay(motebitId: string, amountMicro: number, referenceId: string): void {
  const relayUrl = process.env.RELAY_API_URL ?? "https://relay.motebit.com";
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

function getProviderApiKey(provider: InferenceHost): string | null {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ?? null;
    case "openai":
      return process.env.OPENAI_API_KEY ?? null;
    case "google":
      return process.env.GOOGLE_AI_API_KEY ?? null;
    case "groq":
      return process.env.GROQ_API_KEY ?? null;
    case "local-server":
      // On-device host — the user's own inference server, not a
      // remote endpoint the proxy holds keys for. PR 3 of the
      // auto-routing arc (`docs/doctrine/auto-routing-as-protocol-
      // primitive.md`) added `local-server` to `InferenceHost`;
      // the proxy never routes to this host (on-device consumers
      // bypass the proxy entirely). Returning null here means any
      // catalog entry with `host: "local-server"` fails the
      // "provider key configured" check at `getProviderApiKey(...)`
      // call sites — defense in depth against a future bug that
      // smuggles an on-device model into the proxy's catalog.
      return null;
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
  // Per-turn trace id, hoisted so every failure path can stamp it on both the
  // structured event and the `X-Motebit-Request-Id` response header.
  const requestId = crypto.randomUUID();

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
      return failureResponse({
        requestId,
        status: 500,
        bodyObj: { error: "server_error", message: "Proxy token verification not configured" },
        headers: cors,
        failure: motebitFailure("motebit_infrastructure", "not_configured", 500),
      });
    }

    tokenPayload = await parseProxyToken(proxyTokenStr, relayPubKey);
    if (!tokenPayload) {
      return failureResponse({
        requestId,
        status: 401,
        bodyObj: { error: "invalid_token", message: "Invalid or expired proxy token" },
        headers: cors,
        failure: motebitFailure("motebit_request", "authentication", 401),
      });
    }

    if (tokenPayload.bal <= 0) {
      // Balance reached zero at the proxy. WHY (free-preview burned through vs
      // never-granted vs funded-then-drained) is not knowable here — the proxy
      // has no balance history. The relay's `free_credit.grant_decision` event
      // + ledger carry that causal attribution in its own trust domain.
      return failureResponse({
        requestId,
        status: 402,
        bodyObj: {
          error: "insufficient_balance",
          message: "Deposit funds to use cloud AI.",
          balance: 0,
        },
        headers: cors,
        mode: "proxy-token",
        failure: motebitFailure("motebit_balance", "balance_exhausted", 402),
      });
    }

    authMode = "proxy-token";
  } else {
    return failureResponse({
      requestId,
      status: 401,
      bodyObj: { error: "unauthorized", message: "Provide a proxy token or API key." },
      headers: cors,
      failure: motebitFailure("motebit_request", "authentication", 401),
    });
  }

  const isBYOK = authMode === "byok";
  const limits = isBYOK ? BYOK_LIMITS : DEPOSIT_LIMITS;

  // --- Parse body ---
  const raw = await request.text();
  if (raw.length > limits.maxBody) {
    return failureResponse({
      requestId,
      status: 413,
      bodyObj: { error: "request_too_large" },
      headers: cors,
      mode: authMode,
      failure: motebitFailure("motebit_request", "malformed_request", 413),
    });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return failureResponse({
      requestId,
      status: 400,
      bodyObj: { error: "invalid_json" },
      headers: cors,
      mode: authMode,
      failure: motebitFailure("motebit_request", "malformed_request", 400),
    });
  }

  // --- Validate and resolve model ---
  let resolvedModel = body.model as string | undefined;
  if (!resolvedModel) {
    return failureResponse({
      requestId,
      status: 400,
      bodyObj: { error: "invalid_model", message: "Model is required" },
      headers: cors,
      mode: authMode,
      failure: motebitFailure("motebit_request", "malformed_request", 400),
    });
  }

  // Resolve legacy/class aliases → current canonical model ID.
  // "claude-sonnet" → "claude-sonnet-4-6", old dated versions → current, etc.
  // Keeps deployed clients working when models are upgraded server-side.
  if (resolvedModel !== "auto") {
    resolvedModel = resolveModelAlias(resolvedModel);
  }

  // Auto-routing: classify with Haiku, then dispatch through the
  // protocol-layer auto-router primitive. The proxy is the first
  // CONSUMER registered in `check-routing-decision-coverage` (drift
  // gate #95); BYOK and on-device add as PR 2/3. Doctrine:
  // `docs/doctrine/auto-routing-as-protocol-primitive.md`.
  //
  // Flow:
  //   classifyTask (LLM intent classifier; proxy-internal) → TaskShape
  //   → applyBalanceFilter (motebit-cloud-specific wrapper; protocol-
  //     neutral primitive stays consumer-agnostic)
  //   → dispatchRouting (protocol primitive in @motebit/policy)
  //   → handle RoutingDecision { route | fallback | deny }
  let classifierCost = 0;
  let routingReason: string | undefined;
  if (resolvedModel === "auto" && !isBYOK) {
    const classifierKey = process.env.ANTHROPIC_API_KEY;
    if (classifierKey) {
      const lastMsg = (body.messages as Array<{ content: string }>)?.at(-1)?.content ?? "";
      const classifiedTaskType = await classifyTask(classifierKey, lastMsg);
      // Narrow to the closed TaskShape registry. Unknown classifier
      // outputs fall back to "chat" (the conversational default).
      const taskShape = isTaskShape(classifiedTaskType) ? classifiedTaskType : "chat";
      const balance = tokenPayload?.bal ?? 0;
      // Pre-filter the catalog by motebit-cloud balance affordability
      // (consumer-side wrapper; protocol layer stays consumer-neutral).
      const fullCatalog = getProviderCatalog();
      const affordableCatalog = applyBalanceFilter(fullCatalog, balance);
      // Constrain to motebit-cloud-allowed jurisdiction (US-only today).
      const constraints: RoutingConstraint = { jurisdiction: "US" };
      const decision = dispatchRouting(
        taskShape,
        affordableCatalog,
        constraints,
        REFERENCE_ROUTING_POLICY,
      );
      // Honor the typed RoutingDecision discriminator. Every consumer
      // of dispatchRouting MUST handle route + fallback + deny per the
      // structural contract enforced by `check-routing-decision-
      // coverage` (#95).
      switch (decision.kind) {
        case "route": {
          // Confirm the picked model's provider key is configured;
          // otherwise fall back to the auto-default (Sonnet).
          const pickedProvider = getModelProvider(decision.model);
          if (pickedProvider && getProviderApiKey(pickedProvider)) {
            resolvedModel = decision.model;
            routingReason = decision.reason;
          } else {
            resolvedModel = AUTO_DEFAULT_MODEL;
            routingReason = `picked model ${decision.model} but no provider key configured; using default ${AUTO_DEFAULT_MODEL}`;
          }
          break;
        }
        case "fallback": {
          const pickedProvider = getModelProvider(decision.backup);
          if (pickedProvider && getProviderApiKey(pickedProvider)) {
            resolvedModel = decision.backup;
            routingReason = decision.reason;
          } else {
            resolvedModel = AUTO_DEFAULT_MODEL;
            routingReason = `fallback model ${decision.backup} but no provider key configured; using default ${AUTO_DEFAULT_MODEL}`;
          }
          break;
        }
        case "deny": {
          // No catalog entry survived constraints — fall back to
          // AUTO_DEFAULT_MODEL. Real production policy: surface the
          // deny to the user (HTTP 4xx) rather than silently picking
          // Sonnet; this preserves PR-1's no-regression posture.
          resolvedModel = AUTO_DEFAULT_MODEL;
          routingReason = `dispatch denied (${decision.reason}); using default ${AUTO_DEFAULT_MODEL}`;
          break;
        }
      }
      // Estimate classifier cost (~200 tokens in + ~20 tokens out via Haiku)
      classifierCost = calculateCostMicro(CLASSIFIER_MODEL, 200, 20);
    } else {
      resolvedModel = AUTO_DEFAULT_MODEL;
      routingReason = `ANTHROPIC_API_KEY not configured; using default ${AUTO_DEFAULT_MODEL}`;
    }
  }
  // routingReason surfaces on the successful response paths below as
  // the `X-Motebit-Routing-Reason` header (sibling-shape of
  // `X-Motebit-Content-Manifest` — observability metadata, plain
  // string vs structured manifest). Chrome rendering of the reason
  // (chrome narration surface vs inspector panel) is PR 4b's UX
  // decision; PR 4a (this) only plumbs the data through.

  if (authMode === "proxy-token" && tokenPayload) {
    // "auto" is always allowed; for specific models check the allowlist
    if (
      body.model !== "auto" &&
      tokenPayload.models.length > 0 &&
      !tokenPayload.models.includes(resolvedModel)
    ) {
      return failureResponse({
        requestId,
        status: 400,
        bodyObj: { error: "invalid_model", message: `Allowed: ${tokenPayload.models.join(", ")}` },
        headers: cors,
        model: resolvedModel,
        mode: "proxy-token",
        failure: motebitFailure("motebit_request", "model_unavailable", 400),
      });
    }

    // Motebit-cloud jurisdiction admission predicate. Lifts the previously-
    // tribal "DeepSeek-is-BYOK-only-because-Chinese-hosted" decision to
    // structural enforcement: if a future MODEL_CONFIG addition has a
    // non-US jurisdiction, motebit-cloud refuses the route until the
    // jurisdictional policy is explicitly widened. BYOK mode bypasses
    // this filter (the user's own key, the user's own choice; sovereignty
    // doctrine stays orthogonal to tier policy).
    if (resolvedModel !== "auto" && !isModelAllowedInMotebitCloud(resolvedModel)) {
      return failureResponse({
        requestId,
        status: 451,
        bodyObj: {
          error: "jurisdiction_not_permitted",
          message: `${resolvedModel} is not available in motebit-cloud routing. Use BYOK to call this model with your own API key.`,
        },
        headers: cors,
        model: resolvedModel,
        mode: "proxy-token",
        failure: motebitFailure("motebit_request", "model_unavailable", 451),
      });
    }
  }

  // --- Resolve provider and API key ---
  const provider = getModelProvider(resolvedModel);

  let apiKey: string | null;
  if (isBYOK) {
    // BYOK: user's key goes to Anthropic (default) or detected provider
    apiKey = clientApiKey;
  } else {
    if (!provider) {
      return failureResponse({
        requestId,
        status: 400,
        bodyObj: { error: "invalid_model", message: `Model not supported: ${resolvedModel}` },
        headers: cors,
        model: resolvedModel,
        mode: authMode,
        failure: motebitFailure("motebit_request", "model_unavailable", 400),
      });
    }
    apiKey = getProviderApiKey(provider);
    if (!apiKey) {
      return failureResponse({
        requestId,
        status: 501,
        bodyObj: {
          error: "provider_not_configured",
          message: `${provider} is not configured on this proxy`,
        },
        headers: cors,
        model: resolvedModel,
        mode: authMode,
        failure: motebitFailure("motebit_infrastructure", "not_configured", 501),
      });
    }
  }

  if (!apiKey) {
    return failureResponse({
      requestId,
      status: 500,
      bodyObj: { error: "server_error", message: "No API key available" },
      headers: cors,
      model: resolvedModel,
      mode: authMode,
      failure: motebitFailure("motebit_infrastructure", "not_configured", 500),
    });
  }

  // --- Validate messages ---
  const messages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    return failureResponse({
      requestId,
      status: 400,
      bodyObj: { error: "invalid_messages" },
      headers: cors,
      model: resolvedModel,
      mode: authMode,
      failure: motebitFailure("motebit_request", "malformed_request", 400),
    });
  }
  if (messages.length > limits.maxMsgs) {
    return failureResponse({
      requestId,
      status: 400,
      bodyObj: { error: "too_many_messages", message: `Max ${limits.maxMsgs} messages` },
      headers: cors,
      model: resolvedModel,
      mode: authMode,
      failure: motebitFailure("motebit_request", "malformed_request", 400),
    });
  }

  // --- Build and send provider request ---
  const resolvedProvider = provider ?? "anthropic"; // BYOK defaults to Anthropic
  const providerReq = buildProviderRequest(
    resolvedProvider,
    apiKey,
    resolvedModel,
    body,
    limits.maxTokens,
  );

  let providerRes: Response;
  try {
    providerRes = await fetch(providerReq.url, {
      method: "POST",
      headers: providerReq.headers,
      body: providerReq.body,
    });
  } catch (err) {
    // Transport failure: fetch threw before any HTTP response (DNS, connection
    // refused, abort, read timeout). Currently this would surface as an opaque
    // edge-runtime error; classify it as a network/timeout failure instead.
    const failure = classifyProviderTransportFailure({
      provider: resolvedProvider,
      errorName: err instanceof Error ? err.name : undefined,
    });
    return failureResponse({
      requestId,
      status: 502,
      bodyObj: {
        error: "provider_unreachable",
        message: "Upstream provider could not be reached.",
      },
      headers: cors,
      model: resolvedModel,
      mode: authMode,
      failure,
    });
  }

  // Pre-stream upstream failure: classify + emit one event, then preserve the
  // provider's own body/status pass-through (adding the trace header). This is
  // the recovery-safe boundary — no client bytes sent, no debit taken yet.
  if (!providerRes.ok) {
    let parsedBody: unknown = null;
    let bodyText = "";
    try {
      bodyText = await providerRes.text();
      parsedBody = bodyText === "" ? null : JSON.parse(bodyText);
    } catch {
      parsedBody = null; // non-JSON error body — classify on status alone; never logged
    }
    const failure = classifyProviderHttpFailure({
      provider: resolvedProvider,
      status: providerRes.status,
      headers: providerRes.headers,
      body: parsedBody,
      nowMs: Date.now(),
    });
    emitProxyFailure({ requestId, model: resolvedModel, mode: authMode, failure });
    // Forward ONLY the safe operational header from upstream — the client may
    // still want the provider's retry guidance until in-proxy recovery (PR3)
    // exists. The rest of the upstream header set is deliberately not relayed.
    const retryAfter = providerRes.headers.get("Retry-After");
    return new Response(bodyText, {
      status: providerRes.status,
      headers: {
        ...cors,
        "Content-Type": providerRes.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "no-cache",
        "X-Motebit-Request-Id": requestId,
        ...(retryAfter != null ? { "Retry-After": retryAfter } : {}),
      },
    });
  }

  // --- Stream response and extract usage for debit ---
  if (authMode === "proxy-token" && tokenPayload && providerRes.ok && providerRes.body) {
    const mid = tokenPayload.mid;
    const model = resolvedModel;
    const prov = resolvedProvider;
    const usage: UsageAccumulator = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

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
        const cost =
          calculateCostMicro(
            model,
            usage.input,
            usage.output,
            usage.cacheRead,
            usage.cacheCreation,
          ) + classifierCost;
        // Log normalized token fields for billing verification. `extractUsage`
        // normalizes every provider so `input` is UNCACHED and `cacheRead` is the
        // cached/discounted portion (additive) — so the calculateCostMicro formula
        // (uncached + cacheRead·discount + cacheCreation·1.25) is correct without
        // double-counting. cacheRead > 0 here is the proof caching is landing.
        console.log(
          JSON.stringify({
            event: "proxy.usage",
            requestId,
            model,
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheCreation: usage.cacheCreation,
            costMicro: cost,
            motebitId: mid,
          }),
        );
        if (cost > 0) debitRelay(mid, cost, requestId);
      }
    })();

    return new Response(readable, {
      status: providerRes.status,
      headers: {
        ...cors,
        "Content-Type": providerRes.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-cache",
        ...(routingReason ? { "X-Motebit-Routing-Reason": routingReason } : {}),
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
      ...(routingReason ? { "X-Motebit-Routing-Reason": routingReason } : {}),
    },
  });
}
