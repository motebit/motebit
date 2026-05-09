/**
 * Extracted bootstrap logic — pure functions for provider resolution, local
 * inference detection, config validation, and conversation history cleaning.
 *
 * These live here (not in main.ts) so they can be tested without DOM side effects.
 */
import { stripInternalTags } from "@motebit/ai-core";
import type { ProviderConfig } from "./storage";

// === Local Inference Probing ===

export interface LocalEndpoint {
  url: string;
  type: "ollama" | "openai";
}

export const DEFAULT_LOCAL_ENDPOINTS: readonly LocalEndpoint[] = [
  { url: "http://localhost:11434", type: "ollama" },
  { url: "http://localhost:1234", type: "openai" },
  { url: "http://localhost:8080", type: "openai" },
  { url: "http://localhost:1337", type: "openai" },
  { url: "http://localhost:8000", type: "openai" },
] as const;

/**
 * Discriminated outcome of a local-inference probe. Replaces the
 * prior `Promise<ProbeResult | null>` shape that collapsed every
 * failure mode to `null` — silent failure the user couldn't act on.
 *
 * Per the typed-truth-perception doctrine: typed semantic field on
 * the result, surface reads it and renders kind-specific
 * remediation. The four kinds map to four user actions:
 *
 *   ok                    → connect, populate model list
 *   server_up_no_models   → "pull a model" (the server is running,
 *                            just empty)
 *   cors_blocked          → "set OLLAMA_ORIGINS" copy-paste command
 *                            (the server is reachable but the
 *                            browser drops the response over CORS)
 *   unreachable           → "start your server" (no response at all)
 *
 * Caller-side surface lives in `apps/web/src/ui/settings.ts`'s
 * `detectAndPopulateLocalServer` + `reprobeCustomEndpoint`. New
 * callers MUST branch on `kind` rather than truthy-check the
 * shape — that's the discipline this taxonomy exists to enforce.
 *
 * Doctrine: `docs/doctrine/typed-truth-perception.md`. The probe
 * IS the dispatch layer for "is the local server usable from this
 * origin?" — the typed kind is the structural floor; the surface
 * renders accordingly. Without the taxonomy, the `models = []`
 * fallthrough became the wire signal for three different
 * remediations and the user couldn't tell which.
 */
export type ProbeOutcome =
  | {
      readonly kind: "ok";
      readonly baseUrl: string;
      readonly type: "ollama" | "openai";
      readonly models: string[];
    }
  | {
      readonly kind: "server_up_no_models";
      readonly baseUrl: string;
      readonly type: "ollama" | "openai";
    }
  | { readonly kind: "cors_blocked"; readonly baseUrl: string }
  | { readonly kind: "unreachable"; readonly baseUrl: string };

/**
 * Classify a fetch failure into either `cors_blocked` or
 * `unreachable`. The browser's fetch API surfaces both as
 * `TypeError "Failed to fetch"` — the response is dropped before
 * delivery in the CORS case, so JavaScript can't observe the
 * difference at the API level.
 *
 * Heuristic: HTTPS origin probing http://localhost:* is *most
 * likely* a CORS preflight rejection. The W3C "potentially
 * trustworthy origins" spec permits HTTPS→localhost requests over
 * the wire (no mixed-content block); Ollama / LM Studio / Jan all
 * default to localhost-only `Access-Control-Allow-Origin`, so the
 * browser receives the response and drops it. Other origin /
 * target shapes (HTTP origin or non-localhost target) lean
 * unreachable.
 *
 * `originProtocol` is injectable so the heuristic is testable
 * without mutating jsdom's `location`. Production callers pass
 * `globalThis.location?.protocol` (which jsdom populates) or
 * default to "http:" when unknown — the safer default since
 * "http:" never triggers the CORS branch.
 */
export function classifyProbeFailure(
  baseUrl: string,
  originProtocol: string,
): { readonly kind: "cors_blocked" } | { readonly kind: "unreachable" } {
  const isHttpsOrigin = originProtocol === "https:";
  const isHttpLocalhost = /^http:\/\/(localhost|127\.0\.0\.1)/i.test(baseUrl);
  if (isHttpsOrigin && isHttpLocalhost) return { kind: "cors_blocked" };
  return { kind: "unreachable" };
}

function readOriginProtocol(): string {
  // Defensive — `location` may be undefined in some Node test
  // environments. Default to "http:" so the heuristic falls
  // through to "unreachable" (the safer story when we can't tell).
  if (typeof globalThis !== "undefined" && "location" in globalThis) {
    const loc = (globalThis as { location?: { protocol?: string } }).location;
    if (loc?.protocol) return loc.protocol;
  }
  return "http:";
}

/**
 * Probe a single local inference endpoint for available models.
 * Returns a typed `ProbeOutcome` discriminating success, empty
 * server, CORS blocking, and unreachable — enables the surface
 * to render kind-specific remediation instead of a single
 * "no models found" silent failure.
 *
 * @param baseUrl   - Base URL of the inference server
 * @param type      - "ollama" or "openai" (determines probe strategy)
 * @param fetchFn   - Fetch implementation (injectable for testing)
 * @param timeoutMs - Abort timeout in milliseconds (default 2000)
 * @param originProtocol - Origin protocol for CORS heuristic
 *                          (injectable for testing; production
 *                          reads `globalThis.location.protocol`)
 */
export async function probeLocalModels(
  baseUrl: string,
  type: "ollama" | "openai",
  fetchFn: typeof fetch = globalThis.fetch,
  timeoutMs: number = 2000,
  originProtocol: string = readOriginProtocol(),
): Promise<ProbeOutcome> {
  let serverResponded = false;
  let firstFailureKind: ProbeOutcome["kind"] | null = null;
  try {
    // Ollama-native API first
    if (type === "ollama") {
      const res = await fetchFn(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      serverResponded = true;
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const models = (data.models ?? []).map((m) => m.name);
        if (models.length > 0) return { kind: "ok", baseUrl, type, models };
        // Ollama responded but reported zero models — remember the
        // shape and try the OpenAI path before settling on
        // server_up_no_models. A server that exposes both APIs
        // (Ollama with the OpenAI shim) might have models on /v1.
        firstFailureKind = "server_up_no_models";
      }
    }
    // OpenAI-compatible /v1/models
    const res = await fetchFn(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    serverResponded = true;
    if (!res.ok) {
      // Server reachable but rejected the request — treat as the
      // best-known failure shape. v1 default to unreachable so the
      // surface guides the user toward "is your server actually
      // configured to expose this?"
      return firstFailureKind === "server_up_no_models"
        ? { kind: "server_up_no_models", baseUrl, type }
        : { kind: "unreachable", baseUrl };
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map((m) => m.id);
    if (models.length > 0) return { kind: "ok", baseUrl, type: "openai", models };
    return { kind: "server_up_no_models", baseUrl, type: "openai" };
  } catch (err) {
    // If the server already responded once during this probe (the
    // Ollama path returned ok:false or empty before the OpenAI
    // path threw), the failure is "server up but the second call
    // failed" — still server_up_no_models is the most actionable
    // story for the user.
    if (serverResponded && firstFailureKind === "server_up_no_models") {
      return { kind: "server_up_no_models", baseUrl, type };
    }
    if (err instanceof TypeError) {
      // Browser fetch-level failure. CORS and network-unreachable
      // are indistinguishable at the API surface; the heuristic
      // disambiguates by origin shape.
      return { ...classifyProbeFailure(baseUrl, originProtocol), baseUrl };
    }
    // SyntaxError (malformed JSON), AbortError (timeout), Error
    // (generic) — none of these are CORS, so unreachable is the
    // honest call.
    if (err instanceof SyntaxError) {
      console.warn(`probe ${baseUrl}: unexpected parse error:`, err.message); // eslint-disable-line no-console -- runtime diagnostic for inference probe failures
    }
    return { kind: "unreachable", baseUrl };
  }
}

/**
 * Probe all known local inference endpoints in parallel.
 * Returns the first `ok` outcome (ordered by endpoint list
 * priority) when one exists; otherwise returns the first
 * non-`ok` outcome — typically `cors_blocked` over `unreachable`
 * because the CORS heuristic fires preferentially when an HTTPS
 * origin probes localhost. The surface uses this prioritization
 * to render the most actionable remediation when the user has a
 * server up but blocked.
 */
export async function detectLocalInference(
  endpoints: readonly LocalEndpoint[] = DEFAULT_LOCAL_ENDPOINTS,
  fetchFn: typeof fetch = globalThis.fetch,
  timeoutMs: number = 2000,
  originProtocol: string = readOriginProtocol(),
): Promise<ProbeOutcome> {
  const probes = endpoints.map((ep) =>
    probeLocalModels(ep.url, ep.type, fetchFn, timeoutMs, originProtocol),
  );
  const results = await Promise.allSettled(probes);

  // First pass: any `ok` outcome wins.
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.kind === "ok") {
      return result.value;
    }
  }
  // Second pass: prefer the most-actionable failure. Order:
  // server_up_no_models (the user has the closest thing to a
  // working setup) → cors_blocked (one shell command away) →
  // unreachable (most generic).
  const order: ProbeOutcome["kind"][] = ["server_up_no_models", "cors_blocked", "unreachable"];
  for (const wantedKind of order) {
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.kind === wantedKind) {
        return result.value;
      }
    }
  }
  // No probe even fulfilled — every endpoint rejected the promise
  // before yielding an outcome. Fall back to the first endpoint as
  // unreachable so the surface still has a baseUrl to display.
  return { kind: "unreachable", baseUrl: endpoints[0]?.url ?? "" };
}

// === Model Selection ===

/** Prefer the largest/best model from a list (70b > 32b > 8b > first). */
export function pickBestModel(models: string[]): string {
  return (
    models.find((m) => m.includes("70b")) ??
    models.find((m) => m.includes("32b")) ??
    models.find((m) => m.includes("8b")) ??
    models[0]!
  );
}

// === Provider Resolution ===

export interface ResolvedProvider {
  config: ProviderConfig;
  source: "saved" | "local" | "proxy" | "webllm" | "none";
}

/**
 * Given a saved config, determine the provider config to use.
 * Pure decision logic — does not perform I/O.
 *
 * - Proxy configs always need fresh token bootstrap (returns source "proxy")
 * - WebLLM configs are used directly
 * - Cloud/local configs with required fields are used directly
 * - Invalid configs return source "none"
 */
export function resolveProviderFromSaved(saved: ProviderConfig): ResolvedProvider {
  switch (saved.mode) {
    case "motebit-cloud":
      // Always needs fresh token bootstrap, even if a stale token is persisted.
      return { config: saved, source: "proxy" };
    case "on-device":
      // On-device configs don't need any external state to be considered "saved".
      return { config: saved, source: "saved" };
    case "byok":
      // BYOK needs an API key — without it we can't connect.
      return { config: saved, source: saved.apiKey ? "saved" : "none" };
  }
}

/**
 * Build a `UnifiedProviderConfig` from a successful local probe.
 * Always collapses to `on-device/local-server` regardless of the
 * probe type — the runtime factory picks Ollama vs. OpenAI-compat
 * transport from the endpoint shape.
 *
 * Caller MUST narrow `ProbeOutcome` to `kind === "ok"` first;
 * the parameter type enforces this so a non-ok outcome can't be
 * silently passed in.
 */
export function configFromProbeResult(
  probe: Extract<ProbeOutcome, { kind: "ok" }>,
): ProviderConfig {
  return {
    mode: "on-device",
    backend: "local-server",
    model: pickBestModel(probe.models),
    endpoint: probe.baseUrl,
  };
}

// === Config Validation ===

/**
 * Synchronous validity check for a `UnifiedProviderConfig`.
 * Returns true if the config has the minimum required fields to attempt a connection.
 */
export function isConfigValid(config: ProviderConfig): boolean {
  switch (config.mode) {
    case "motebit-cloud":
      return Boolean(config.proxyToken);
    case "byok":
      return Boolean(config.apiKey);
    case "on-device":
      switch (config.backend) {
        case "webllm":
        case "apple-fm":
        case "mlx":
          return Boolean(config.model);
        case "local-server":
          // An endpoint alone is enough — the server may not have a "default" model.
          return Boolean(config.endpoint ?? config.model);
      }
  }
}

/**
 * Async reachability check for a provider config.
 * For remote/local providers, probes the endpoint. For in-browser, returns true.
 */
export async function isConfigReachable(
  config: ProviderConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  timeoutMs: number = 2000,
): Promise<boolean> {
  if (config.mode === "on-device") {
    if (config.backend === "webllm" || config.backend === "apple-fm" || config.backend === "mlx") {
      return true;
    }
    // local-server — probe it.
    const baseUrl = config.endpoint ?? "http://localhost:11434";
    try {
      const res = await fetchFn(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return true;
      // Fallback: OpenAI-compat /v1/models
      const res2 = await fetchFn(`${baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res2.ok;
    } catch (err) {
      if (err instanceof TypeError || err instanceof SyntaxError) {
        console.warn(`reachability check ${baseUrl}: unexpected error:`, err.message); // eslint-disable-line no-console -- runtime diagnostic for reachability probe
      }
      return false;
    }
  }

  if (config.mode === "motebit-cloud") {
    // Proxy reachability is determined by token bootstrap, not a simple probe
    return Boolean(config.proxyToken);
  }

  // BYOK — we can't really probe without burning a request,
  // so we just validate the config has the required fields
  return isConfigValid(config);
}

// === Conversation History Cleaning ===

export interface ConversationMessage {
  role: string;
  content: string;
}

/**
 * Clean conversation history for display — strip leaked internal tags
 * (thinking, memory, state) and collapse whitespace.
 */
export function cleanConversationHistory(
  messages: ConversationMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const result: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const clean = stripInternalTags(msg.content).replace(/ {2,}/g, " ").trim();
    if (clean) {
      result.push({ role: msg.role, content: clean });
    }
  }
  return result;
}
