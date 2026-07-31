/**
 * Live model-catalog discovery — the pluggability contract enforced at the
 * provider seam (#475). The catalog's canonical truth lives OUTSIDE the
 * repo (the provider's live models endpoint); every static table in
 * `@motebit/sdk` is a snapshot that drifts — the 2026-07-29 night found
 * three layers of that drift live (fabricated ids, removed sampling
 * params, removed budget_tokens). Metabolic principle: absorb the catalog
 * through an adapter with an offline fallback, never hardcode it as truth.
 *
 * Fail-soft by construction: any fetch failure (offline, bad key, timeout)
 * degrades to the static fallback tables, clearly marked
 * `source: "fallback"` with the reason — `/model` must render on an
 * airplane, and a provider outage must never brick a session.
 */

import { ANTHROPIC_MODELS, OPENAI_MODELS, LOCAL_SERVER_SUGGESTED_MODELS } from "@motebit/sdk";

export interface CatalogModel {
  id: string;
  displayName?: string;
}

export interface ModelCatalog {
  provider: string;
  /** "live" = fetched from the provider's models endpoint just now;
   * "fallback" = the committed snapshot tables (drift-prone, marked). */
  source: "live" | "fallback";
  models: CatalogModel[];
  /** Why the live fetch degraded, when it did. */
  fallbackReason?: string;
}

export interface DiscoverModelsParams {
  provider: string;
  apiKey?: string;
  /** Provider base URL (local-server / proxy); defaults per provider. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Test seam. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 4000;

function fallbackFor(provider: string, reason: string): ModelCatalog {
  const table =
    provider === "anthropic"
      ? ANTHROPIC_MODELS
      : provider === "openai"
        ? OPENAI_MODELS
        : provider === "local-server" || provider === "ollama"
          ? LOCAL_SERVER_SUGGESTED_MODELS
          : [];
  return {
    provider,
    source: "fallback",
    models: (table as readonly string[]).map((id) => ({ id })),
    fallbackReason: reason,
  };
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, { headers, signal: controller.signal });
    if (!resp.ok) throw new Error(`${resp.status} from ${url}`);
    return (await resp.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover the ACTIVE provider's servable models, live. The list shown to a
 * user IS the list the provider serves — the static alias table demotes to
 * name resolution and offline fallback (#471's provider-blind list, second
 * half).
 */
export async function discoverModels(params: DiscoverModelsParams): Promise<ModelCatalog> {
  const { provider } = params;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = params.fetchFn ?? fetch;

  try {
    if (provider === "anthropic") {
      if (!params.apiKey) return fallbackFor(provider, "no API key for live catalog");
      const body = (await fetchJson(
        "https://api.anthropic.com/v1/models?limit=100",
        { "x-api-key": params.apiKey, "anthropic-version": "2023-06-01" },
        timeoutMs,
        fetchFn,
      )) as { data?: Array<{ id?: string; display_name?: string }> };
      const models = (body.data ?? [])
        .filter((m): m is { id: string; display_name?: string } => typeof m.id === "string")
        .map((m) => ({ id: m.id, ...(m.display_name ? { displayName: m.display_name } : {}) }));
      if (models.length === 0) return fallbackFor(provider, "live catalog came back empty");
      return { provider, source: "live", models };
    }

    if (provider === "openai") {
      if (!params.apiKey) return fallbackFor(provider, "no API key for live catalog");
      const body = (await fetchJson(
        "https://api.openai.com/v1/models",
        { Authorization: `Bearer ${params.apiKey}` },
        timeoutMs,
        fetchFn,
      )) as { data?: Array<{ id?: string }> };
      // The raw list carries embeddings/audio/etc — keep the chat families.
      const models = (body.data ?? [])
        .filter((m): m is { id: string } => typeof m.id === "string")
        .filter((m) => /^(gpt-|o[0-9]|chatgpt)/.test(m.id))
        .map((m) => ({ id: m.id }));
      if (models.length === 0) return fallbackFor(provider, "live catalog came back empty");
      return { provider, source: "live", models };
    }

    if (provider === "local-server" || provider === "ollama") {
      const base = (params.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
      // Ollama-native listing first; OpenAI-compatible /v1/models as the
      // second shot (LM Studio, llama.cpp servers).
      try {
        const body = (await fetchJson(`${base}/api/tags`, {}, timeoutMs, fetchFn)) as {
          models?: Array<{ name?: string }>;
        };
        const models = (body.models ?? [])
          .filter((m): m is { name: string } => typeof m.name === "string")
          .map((m) => ({ id: m.name }));
        if (models.length > 0) return { provider, source: "live", models };
      } catch {
        // fall through to the OpenAI-compatible shape
      }
      const body = (await fetchJson(`${base}/v1/models`, {}, timeoutMs, fetchFn)) as {
        data?: Array<{ id?: string }>;
      };
      const models = (body.data ?? [])
        .filter((m): m is { id: string } => typeof m.id === "string")
        .map((m) => ({ id: m.id }));
      if (models.length === 0) return fallbackFor(provider, "local server lists no models");
      return { provider, source: "live", models };
    }

    // google / proxy / groq / deepseek: no live adapter yet — honest fallback.
    return fallbackFor(provider, `no live catalog adapter for ${provider}`);
  } catch (err) {
    return fallbackFor(provider, err instanceof Error ? err.message : String(err));
  }
}
