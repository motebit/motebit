/**
 * Extracted bootstrap logic — pure functions for provider resolution, local
 * inference detection, config validation, and conversation history cleaning.
 *
 * These live here (not in main.ts) so they can be tested without DOM side effects.
 */
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

export interface ProbeResult {
  baseUrl: string;
  type: "ollama" | "openai";
  models: string[];
}

/**
 * Probe a single local inference endpoint for available models.
 * Returns null if the endpoint is unreachable or has no models.
 *
 * @param baseUrl   - Base URL of the inference server
 * @param type      - "ollama" or "openai" (determines probe strategy)
 * @param fetchFn   - Fetch implementation (injectable for testing)
 * @param timeoutMs - Abort timeout in milliseconds (default 2000)
 */
export async function probeLocalModels(
  baseUrl: string,
  type: "ollama" | "openai",
  fetchFn: typeof fetch = globalThis.fetch,
  timeoutMs: number = 2000,
): Promise<ProbeResult | null> {
  try {
    // Ollama-native API first
    if (type === "ollama") {
      const res = await fetchFn(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const models = (data.models ?? []).map((m) => m.name);
        if (models.length > 0) return { baseUrl, type, models };
      }
    }
    // OpenAI-compatible /v1/models
    const res = await fetchFn(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map((m) => m.id);
    if (models.length > 0) return { baseUrl, type: "openai", models };
  } catch (err) {
    // Expected: server not running, connection refused, DNS failure, timeout.
    // Log unexpected errors (parse failures, TypeError) for debugging.
    if (err instanceof TypeError || err instanceof SyntaxError) {
      console.warn(`probe ${baseUrl}: unexpected error:`, err.message); // eslint-disable-line no-console -- runtime diagnostic for inference probe failures
    }
  }
  return null;
}

/**
 * Probe all known local inference endpoints in parallel.
 * Returns the first successful result (ordered by endpoint list priority).
 */
export async function detectLocalInference(
  endpoints: readonly LocalEndpoint[] = DEFAULT_LOCAL_ENDPOINTS,
  fetchFn: typeof fetch = globalThis.fetch,
  timeoutMs: number = 2000,
): Promise<ProbeResult | null> {
  const probes = endpoints.map((ep) => probeLocalModels(ep.url, ep.type, fetchFn, timeoutMs));
  const results = await Promise.allSettled(probes);

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      return result.value;
    }
  }
  return null;
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
 * Build a `UnifiedProviderConfig` from a local probe result.
 * Always collapses to `on-device/local-server` regardless of the probe type —
 * the runtime factory picks Ollama vs. OpenAI-compat transport from the endpoint shape.
 */
export function configFromProbeResult(probe: ProbeResult): ProviderConfig {
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
    const clean = msg.content
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
      .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
      .replace(/<state\s+[^>]*\/>/g, "")
      .replace(/ {2,}/g, " ")
      .trim();
    if (clean) {
      result.push({ role: msg.role, content: clean });
    }
  }
  return result;
}
