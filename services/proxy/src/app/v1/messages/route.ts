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
import { after } from "next/server";
import { isTaskShape, type RoutingConstraint } from "@motebit/protocol";
import { dispatchRouting, applyBalanceFilter, REFERENCE_ROUTING_POLICY } from "@motebit/policy";
// Provider request shaping (incl. Anthropic prompt-caching) lives in a pure,
// unit-tested sibling module — the edge route is glue, the cost-critical request
// shape is testable on its own.
import { buildProviderRequest, resolveMaxTokens } from "./provider-request";
// Stream metering (pure, unit-tested) — forwards the provider stream and
// meters what the provider consumed, client abort or not.
import { meterStream } from "./stream-accounting";
// Deny-by-default request-feature boundary: what the meter cannot price is
// refused before anything spends, never under-billed.
import { findUnsupportedFeature } from "./request-features";
// Pre-stream failure classification + the shared one-event-per-failure surface.
// Observation only (no recovery) — see `inference/classify.ts`.
import {
  classifyProviderHttpFailure,
  classifyProviderTransportFailure,
  motebitFailure,
} from "../../../inference/classify";
import { failureResponse, emitProxyFailure } from "../../../inference/failure-response";
// Spend controls for the motebit-cloud path: live-ish balance (per-token spent
// counter), per-identity rate and concurrency — enforced BEFORE anything spends.
import { admitSpend, type SpendAdmission } from "../../../spend-controls";
import { debitRelay, resolveBillingConfig, DEBIT_MAX_ATTEMPTS } from "../../../billing";

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

/** The classifier's `max_tokens` — also the output bound of its upper-bound cost. */
const CLASSIFIER_MAX_TOKENS = 30;
/**
 * Upper bound on the classifier's input tokens, billed only when a 2xx reply
 * carries no usable `usage` block. The prompt is a ~350-char template plus at
 * most 500 UTF-16 code units of the message; a code unit is at most 3 UTF-8
 * bytes and a byte-level BPE token covers at least one byte, so the input is
 * < 350 + 3·500 + framing ≈ 1.9k tokens. 2048 bounds it from above: never an
 * undercharge, and the fallback is reachable only on a malformed 2xx.
 */
export const CLASSIFIER_INPUT_TOKEN_BOUND = 2048;

/**
 * Outcome of the routing classifier. `costMicro > 0` iff the classifier was
 * actually SPENT on the operator key.
 *
 * Spent ⇔ Anthropic answered 2xx. The API bills a request it serves (2xx); a
 * request it rejects (4xx, or 5xx/529 it failed to serve) is not billed, and a
 * fetch that threw never got a response at all. So non-2xx and transport
 * throws are free; a 2xx is billed from its own `usage` (input + output
 * tokens) when present and well-formed, else at the documented upper bound
 * above — even if its body then fails to parse, the API has billed it.
 */
interface ClassifierOutcome {
  taskType: string;
  costMicro: number;
}

function classifierCostFromUsage(usage: unknown): number {
  const u = (usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (count(u.input_tokens) && count(u.output_tokens)) {
    return calculateCostMicro(CLASSIFIER_MODEL, u.input_tokens, u.output_tokens);
  }
  return calculateCostMicro(CLASSIFIER_MODEL, CLASSIFIER_INPUT_TOKEN_BOUND, CLASSIFIER_MAX_TOKENS);
}

/** Classify a user message to pick the best model. */
async function classifyTask(apiKey: string, message: string): Promise<ClassifierOutcome> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: CLASSIFIER_MAX_TOKENS,
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
  } catch {
    return { taskType: "chat", costMicro: 0 }; // no response — nothing billed; default to Sonnet
  }
  if (!res.ok) return { taskType: "chat", costMicro: 0 }; // rejected by the API — not billed
  type ClassifierReply = { content?: Array<{ text?: unknown }>; usage?: unknown };
  let data: ClassifierReply | null;
  try {
    data = (await res.json()) as ClassifierReply | null;
  } catch {
    data = null; // a 2xx is billed even if its body is unreadable
  }
  const text = data?.content?.[0]?.text;
  return {
    taskType: typeof text === "string" ? text.trim().toLowerCase() : "chat",
    costMicro: classifierCostFromUsage(data?.usage),
  };
}

/** @internal — exported only for unit tests (the stream-metering matrix counts attempts). */
export { DEBIT_MAX_ATTEMPTS };

/**
 * Hold the isolate open for `task` via Next's `after` (the platform's
 * `waitUntil` on Vercel, edge included). Outside a Next request scope (a bare
 * host) `after` throws; the task still runs, unregistered — and says so.
 */
function keepAlive(task: Promise<void>, ids: { requestId: string; motebitId: string }): void {
  try {
    after(task);
  } catch (err) {
    // The task still runs, but the platform does not hold the isolate open
    // for it: a teardown after the response can drop the debit. Loud, so an
    // unregistered tail is a counted reconciliation event, never silent.
    console.error(
      JSON.stringify({
        event: "proxy.accounting_unregistered",
        requestId: ids.requestId,
        motebitId: ids.motebitId,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Anthropic-shaped message roles the motebit-cloud wire accepts. */
type ProxyMessage = { role: "user" | "assistant"; content: string | unknown[] };

/** Element shape check — runs BEFORE anything spends on the operator key. */
function isProxyMessage(m: unknown): m is ProxyMessage {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return false;
  const { role, content } = m as { role?: unknown; content?: unknown };
  return (
    (role === "user" || role === "assistant") &&
    (typeof content === "string" || Array.isArray(content))
  );
}

/** The text the classifier sees: string content, or the text blocks of block content. */
function messageText(m: ProxyMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => {
      const t = (b as { type?: unknown; text?: unknown } | null)?.text;
      return (b as { type?: unknown } | null)?.type === "text" && typeof t === "string" ? t : "";
    })
    .filter((t) => t !== "")
    .join("\n");
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
  /** Granted spend admission (proxy-token mode). Released on every exit after grant. */
  let spendAdmission: (SpendAdmission & { ok: true }) | null = null;

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

    // Billing must be able to land before motebit-cloud serves anything:
    // refuse rather than serve a turn whose relay debit cannot be recorded.
    const billing = resolveBillingConfig();
    if (!billing.ok) {
      console.error(
        JSON.stringify({
          event: "proxy.billing_unconfigured",
          requestId,
          missing: billing.missing,
        }),
      );
      return failureResponse({
        requestId,
        status: 503,
        bodyObj: { error: "server_error", message: "Cloud AI billing is not configured." },
        headers: cors,
        mode: "proxy-token",
        failure: motebitFailure("motebit_infrastructure", "not_configured", 503),
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

    // Spend controls — the bound the token's balance SNAPSHOT cannot provide
    // on its own. Refuses before the classifier or the provider spends.
    const spend = await admitSpend(tokenPayload);
    if (!spend.ok) {
      if (spend.reason === "balance_exhausted") {
        return failureResponse({
          requestId,
          status: 402,
          bodyObj: {
            error: "insufficient_balance",
            message: "This token's balance is spent. Deposit funds to continue.",
            balance: spend.remainingMicro ?? 0,
          },
          headers: cors,
          mode: "proxy-token",
          failure: motebitFailure("motebit_balance", "balance_exhausted", 402),
        });
      }
      if (spend.reason === "store_unavailable") {
        return failureResponse({
          requestId,
          status: 503,
          bodyObj: { error: "server_error", message: "Spend controls unavailable; try again." },
          headers: { ...cors, "Retry-After": "5" },
          mode: "proxy-token",
          failure: motebitFailure("motebit_infrastructure", "not_configured", 503),
        });
      }
      return failureResponse({
        requestId,
        status: 429,
        bodyObj: {
          error: spend.reason,
          message:
            spend.reason === "rate_limited"
              ? "Too many requests for this motebit; slow down."
              : "Too many concurrent requests for this motebit; wait for one to finish.",
        },
        headers: { ...cors, "Retry-After": String(spend.retryAfterSeconds ?? 5) },
        mode: "proxy-token",
        failure: motebitFailure("motebit_request", "rate_limited", 429),
      });
    }
    spendAdmission = spend;

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

  // ── The single settlement obligation ──────────────────────────────────
  // Everything after admission runs inside ONE try/finally. The `finally`
  // settles the turn exactly once — bills the classifier if it was spent and
  // releases the spend slot — on every exit, including a throw at any stage.
  // The only exit that does not settle here is the streamed response, whose
  // pump takes the obligation over (`bill.handedOff`) and settles in its own
  // `finally`, folding the classifier cost into the turn's debit.
  const bill: TurnBill = { classifierCostMicro: 0, handedOff: false };
  try {
    return await serveAdmitted({
      request,
      cors,
      requestId,
      authMode,
      tokenPayload,
      clientApiKey,
      spendAdmission,
      bill,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "proxy.unhandled_error",
        requestId,
        errorName: err instanceof Error ? err.name : typeof err,
      }),
    );
    return failureResponse({
      requestId,
      status: 500,
      bodyObj: { error: "server_error", message: "Internal error" },
      headers: cors,
      mode: authMode,
      failure: motebitFailure("motebit_infrastructure", "server_error", 500),
    });
  } finally {
    if (!bill.handedOff) {
      if (bill.classifierCostMicro > 0 && authMode === "proxy-token" && tokenPayload) {
        await debitRelay(tokenPayload.mid, bill.classifierCostMicro, requestId);
        await spendAdmission?.record(bill.classifierCostMicro);
      }
      await spendAdmission?.release();
    }
  }
}

/**
 * The turn's settlement state. `classifierCostMicro` is set only from a
 * classifier that actually spent; `handedOff` is set only when the streamed
 * pump has taken the obligation over.
 */
interface TurnBill {
  classifierCostMicro: number;
  handedOff: boolean;
}

/** Everything after admission. Never settles itself — see POST's `finally`. */
async function serveAdmitted(ctx: {
  request: Request;
  cors: Record<string, string>;
  requestId: string;
  authMode: "proxy-token" | "byok";
  tokenPayload: ProxyTokenPayload | null;
  clientApiKey: string | null;
  spendAdmission: (SpendAdmission & { ok: true }) | null;
  bill: TurnBill;
}): Promise<Response> {
  const { request, cors, requestId, authMode, tokenPayload, clientApiKey, spendAdmission, bill } =
    ctx;
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

  // --- Validate max_tokens — before anything spends (the classifier included); it is
  //     the output bound the meter relies on, so it is never coerced ---
  if (!resolveMaxTokens(body.max_tokens, limits.maxTokens).ok) {
    return failureResponse({
      requestId,
      status: 400,
      bodyObj: {
        error: "invalid_max_tokens",
        message: "max_tokens must be a positive integer",
      },
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

  // --- Validate messages --- BEFORE the auto-routing classifier: a request
  // whose shape is invalid is refused before anything spends on the operator key.
  const messages = body.messages as unknown[] | undefined;
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isProxyMessage)) {
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

  // --- Metered features only --- BEFORE the classifier: motebit-cloud bills
  // what the provider reports, so a feature whose cost the stream's usage does
  // not carry (server tools, MCP connectors, unknown keys or block types) is
  // refused here, before anything spends. BYOK is not metered (the user's own
  // key), so it is not gated.
  if (authMode === "proxy-token") {
    const unsupported = findUnsupportedFeature(body);
    if (unsupported) {
      return failureResponse({
        requestId,
        status: 400,
        bodyObj: {
          error: "unsupported_feature",
          feature: unsupported.feature,
          path: unsupported.path,
          message: `${unsupported.feature} is not supported on motebit-cloud: its cost cannot be metered. Use BYOK for this feature.`,
        },
        headers: cors,
        model: resolvedModel,
        mode: authMode,
        failure: motebitFailure("motebit_request", "malformed_request", 400),
      });
    }
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
  let routingReason: string | undefined;
  if (resolvedModel === "auto" && !isBYOK) {
    const classifierKey = process.env.ANTHROPIC_API_KEY;
    if (classifierKey) {
      const last = messages.at(-1);
      const classified = await classifyTask(classifierKey, last ? messageText(last) : "");
      // Billed exactly when spent — set before anything below can throw.
      bill.classifierCostMicro = classified.costMicro;
      const classifiedTaskType = classified.taskType;
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
    } else {
      resolvedModel = AUTO_DEFAULT_MODEL;
      routingReason = `ANTHROPIC_API_KEY not configured; using default ${AUTO_DEFAULT_MODEL}`;
    }
  }
  // Header values must be ByteStrings: the router's reasons carry "→", which
  // makes `new Response(...)` throw. Keep the reason readable, ASCII-only.
  const routingHeader: Record<string, string> = routingReason
    ? {
        "X-Motebit-Routing-Reason": routingReason.replace(/→/g, "->").replace(/[^\x20-\x7e]/g, "?"),
      }
    : {};
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
        bodyObj: {
          error: "invalid_model",
          message: `Allowed: ${tokenPayload.models.join(", ")}`,
        },
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

  // --- Stream response and meter usage for the debit ---
  if (authMode === "proxy-token" && tokenPayload && providerRes.ok && providerRes.body) {
    const mid = tokenPayload.mid;
    const classifierCost = bill.classifierCostMicro;
    // Headers are built BEFORE the hand-off — they are the one thing here that
    // can throw (a non-ByteString value). From the hand-off to the return
    // nothing throws, so the obligation is never both handed over and dropped.
    const streamedHeaders = new Headers({
      ...cors,
      "Content-Type": providerRes.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
      // The relay `fee` row's reference_id — correlates a turn to its debit.
      "X-Motebit-Request-Id": requestId,
      ...routingHeader,
    });
    // The metered pump's ONE debit carries `classifierCost` and it releases the
    // slot — the obligation is handed over, POST's `finally` skips.
    bill.handedOff = true;
    // Metering (meter-before-forward, drain-on-abort, KV-bounded settlement)
    // lives in a pure, unit-tested sibling module — see `stream-accounting.ts`.
    // The debit is billing.ts's `debitRelay`, the turn's single settlement
    // path: one debit per request, reference_id = request id.
    const { readable, settled } = meterStream({
      upstream: providerRes.body,
      provider: resolvedProvider,
      model: resolvedModel,
      requestId,
      motebitId: mid,
      extraCostMicro: classifierCost,
      providerRequestBody: providerReq.body,
      maxOutputTokens: providerReq.maxTokens,
      spend: spendAdmission
        ? {
            record: (cost) => spendAdmission.record(cost),
            release: () => spendAdmission.release(),
          }
        : null,
      debit: async (cost) => void (await debitRelay(mid, cost, requestId)),
    });
    // Register the post-response accounting with the platform's waitUntil so
    // an isolate teardown after the response closes cannot drop the debit.
    keepAlive(settled, { requestId, motebitId: mid });
    const streamed = new Response(readable, {
      status: providerRes.status,
      headers: streamedHeaders,
    });

    return streamed;
  }

  // BYOK or non-streaming: pipe directly (a proxy-token request only lands
  // here with no upstream body — nothing was streamed; POST's `finally` still
  // bills the classifier, if it spent, and releases the slot).
  return new Response(providerRes.body, {
    status: providerRes.status,
    headers: {
      ...cors,
      "Content-Type": providerRes.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
      ...routingHeader,
    },
  });
}
