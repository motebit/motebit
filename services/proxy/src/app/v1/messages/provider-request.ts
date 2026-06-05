/**
 * Provider request shaping — pure logic, extracted from the edge route so it can
 * be unit-tested (the cost-critical bit). Maps one logical request (model,
 * system, messages, tools) to each upstream's wire shape, and — critically —
 * carries Anthropic prompt caching correctly: `cache_control` lives on a system
 * content BLOCK (a top-level body field is silently ignored, which previously
 * meant the cloud path cached nothing). OpenAI-shaped upstreams get the system
 * flattened to a plain string.
 */
import type { InferenceHost } from "../../../validation";

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A system prompt block (Anthropic structured-system shape). The client may
 * send `system` as a plain string OR an array of these blocks (the latter
 * carries `cache_control` for prompt caching).
 */
export type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

/** Flatten a string-or-blocks system into plain text (for OpenAI-shaped upstreams). */
export function systemToText(system: unknown): string | undefined {
  if (system == null) return undefined;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const b of system as Array<{ text?: unknown }>) {
      if (b != null && typeof b.text === "string" && b.text.length > 0) parts.push(b.text);
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

/**
 * Coerce a string-or-blocks system into Anthropic structured blocks WITH
 * `cache_control`, so the static prefix caches at 1/10th input cost. A plain
 * string is wrapped into one cached block; client-sent blocks (which already
 * carry their own cache breakpoints) pass through untouched. This is the only
 * shape Anthropic honors — a top-level `cache_control` body field is silently
 * ignored (the prior bug here cached nothing).
 */
export function systemToAnthropicBlocks(system: unknown): SystemBlock[] | undefined {
  if (system == null) return undefined;
  if (Array.isArray(system)) return system as SystemBlock[];
  if (typeof system === "string") {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  return undefined; // unexpected shape — never fabricate "[object Object]"
}

/** Build the provider-specific request. All providers receive the same logical input. */
export function buildProviderRequest(
  provider: InferenceHost,
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  maxTokensCap: number,
): ProviderRequest {
  const messages = body.messages as Array<{ role: string; content: string }>;
  // `system` may be a string (legacy clients) or cache_control-bearing blocks
  // (current ai-core AnthropicProvider). Anthropic upstream gets blocks;
  // OpenAI-shaped upstreams get flattened text.
  const system = systemToText(body.system);
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
          // Structured system blocks carry `cache_control` so Anthropic caches
          // the static prefix (~3K tokens: identity, behavior, injection
          // defense) at 1/10th input cost. MUST be on a content block — the
          // earlier top-level `cache_control` field was silently ignored, so the
          // cloud path cached nothing. Tools pass through (the client marks the
          // last tool cacheable).
          system: systemToAnthropicBlocks(body.system),
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

    case "groq": {
      // Groq exposes an OpenAI-compatible endpoint at api.groq.com/openai/v1;
      // hosts open-source models (Llama 3.3 70B, GPT-OSS 120B) on LPU chips
      // for high-throughput inference. Tools pass through in OpenAI shape.
      const groqMessages = system ? [{ role: "system", content: system }, ...messages] : messages;
      return {
        url: "https://api.groq.com/openai/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: groqMessages,
          max_tokens: maxTokens,
          temperature: body.temperature,
          stream: true,
          stream_options: { include_usage: true },
          ...(body.tools != null ? { tools: body.tools } : {}),
        }),
      };
    }

    case "local-server":
      // On-device consumer's host — the user's own machine. Proxy
      // doesn't route here; the on-device runtime invokes the local
      // server directly. Reaching this arm means a configuration
      // bug at a call site upstream put an on-device model into the
      // proxy's catalog — fail-closed throw so the bug surfaces
      // rather than the proxy silently sending the request to the
      // wrong endpoint. Doctrine: `docs/doctrine/auto-routing-as-
      // protocol-primitive.md` § "PR 3 — on-device consumer".
      throw new Error(
        "proxy.buildProviderRequest: InferenceHost `local-server` is not routable through the proxy — on-device consumers invoke their own local inference server directly",
      );
  }
}
