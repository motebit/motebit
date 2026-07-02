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

/**
 * Normalize messages for OpenAI-shaped upstreams: flatten block content to a
 * plain string (extracting text) and drop `cache_control`, which only Anthropic
 * understands. The ai-core client marks the last message's content as a
 * cache_control block (incremental caching); without this, that block shape
 * would leak to OpenAI/Google/Groq, which expect string content. Tool_use /
 * tool_result blocks have no `.text` and flatten to empty — the pre-existing
 * Anthropic→OpenAI tool-translation gap, neither closed nor worsened here.
 */
function toOpenAiMessages(messages: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const msg = m as { role?: unknown; content?: unknown };
    return {
      role: typeof msg.role === "string" ? msg.role : "user",
      content: typeof msg.content === "string" ? msg.content : (systemToText(msg.content) ?? ""),
    };
  });
}

/**
 * Split a string-or-blocks system into its static prefix and per-turn dynamic
 * suffix. The ai-core AnthropicProvider sends `system` as
 * `[{static, cache_control}, {dynamic}]` (buildSystemPromptCacheable); block[0]
 * is the static doctrine, the rest is the per-turn suffix. A plain string can't
 * be split → it's all "static" (no reorder, same as before).
 */
function splitSystem(system: unknown): { staticText: string; dynamicText?: string } {
  if (typeof system === "string") return { staticText: system };
  if (Array.isArray(system)) {
    const blocks = system as Array<{ text?: unknown }>;
    const staticText = typeof blocks[0]?.text === "string" ? blocks[0].text : "";
    const dynamicParts: string[] = [];
    for (let i = 1; i < blocks.length; i++) {
      const t = blocks[i]?.text;
      if (typeof t === "string" && t.length > 0) dynamicParts.push(t);
    }
    return dynamicParts.length > 0
      ? { staticText, dynamicText: dynamicParts.join("\n\n") }
      : { staticText };
  }
  return { staticText: "" };
}

/**
 * Assemble OpenAI messages for AUTOMATIC prompt caching (mirrors
 * `OpenAIProvider.buildMessages`): static doctrine leads, history follows, and
 * the per-turn dynamic context is a SEPARATE system message anchored immediately
 * before the last user message. That anchor is stable across agentic-loop
 * iterations, so within-turn caching holds, while prior-turn history — now ahead
 * of the dynamic block — caches across turns. OpenAI-proper only (multiple /
 * mid-conversation system messages are well-defined there).
 */
function assembleOpenAiCachedMessages(
  system: unknown,
  convo: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const { staticText, dynamicText } = splitSystem(system);
  const out: Array<{ role: string; content: string }> = [];
  if (staticText) out.push({ role: "system", content: staticText });
  out.push(...convo);
  if (dynamicText != null && dynamicText.length > 0) {
    let lastUserIdx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const dyn = { role: "system", content: dynamicText };
    if (lastUserIdx >= 0) out.splice(lastUserIdx, 0, dyn);
    else out.push(dyn);
  }
  return out;
}

/**
 * Server-side extended-thinking switch for the CLOUD path. The proxy
 * reconstructs the Anthropic request body here, so a client-set `thinking`
 * param would be dropped — this is the single place that can enable it for all
 * cloud users. OFF by default: inert unless `MOTEBIT_EXTENDED_THINKING_BUDGET_TOKENS`
 * is set to a positive integer. Returns the (floored) budget when enabled AND
 * the model supports thinking, else null.
 *
 * The model gate mirrors `@motebit/ai-core`'s `modelSupportsExtendedThinking`
 * (Claude 3.7 Sonnet + 4/5-family Sonnet/Opus; excludes Haiku/pre-3.7). It is
 * inlined rather than imported: the proxy deliberately does NOT depend on
 * ai-core (service boundary — CLAUDE.md "inline trivial utilities at layer
 * boundaries"). Response streaming already passes `thinking_delta`/
 * `signature_delta` through verbatim, and `messages` forward verbatim, so
 * capture + tool-use signature preservation work end-to-end once enabled.
 */
const EXTENDED_THINKING_MIN_BUDGET_TOKENS = 1024;
export function proxyExtendedThinkingBudget(model: string): number | null {
  const raw = process.env.MOTEBIT_EXTENDED_THINKING_BUDGET_TOKENS;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!/claude-(?:3-7-sonnet|(?:opus|sonnet)-(?:[4-9]|\d\d))/i.test(model)) return null;
  return Math.max(EXTENDED_THINKING_MIN_BUDGET_TOKENS, Math.floor(n));
}

/** Build the provider-specific request. All providers receive the same logical input. */
export function buildProviderRequest(
  provider: InferenceHost,
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  maxTokensCap: number,
): ProviderRequest {
  // Anthropic upstream gets the messages verbatim (incl. cache_control blocks on
  // the last message); OpenAI-shaped upstreams get them flattened to strings.
  const rawMessages = body.messages;
  const messages = toOpenAiMessages(rawMessages);
  // `system` may be a string (legacy clients) or cache_control-bearing blocks
  // (current ai-core AnthropicProvider). Anthropic upstream gets blocks;
  // OpenAI-shaped upstreams get flattened text.
  const system = systemToText(body.system);
  const maxTokens =
    maxTokensCap > 0
      ? Math.min((body.max_tokens as number) || maxTokensCap, maxTokensCap)
      : (body.max_tokens as number) || 4096;

  switch (provider) {
    case "anthropic": {
      const thinkingBudget = proxyExtendedThinkingBudget(model);
      const anthropicBody: Record<string, unknown> = {
        model,
        messages: rawMessages,
        // Structured system blocks carry `cache_control` so Anthropic caches
        // the static prefix (~3K tokens: identity, behavior, injection
        // defense) at 1/10th input cost. MUST be on a content block — the
        // earlier top-level `cache_control` field was silently ignored, so the
        // cloud path cached nothing. Tools pass through (the client marks the
        // last tool cacheable).
        system: systemToAnthropicBlocks(body.system),
        // Thinking tokens count toward max_tokens, so reserve headroom above the
        // budget when enabled; otherwise the client/cap value stands.
        max_tokens: thinkingBudget != null ? Math.max(maxTokens, thinkingBudget + 4096) : maxTokens,
        stream: true,
        ...(body.tools != null ? { tools: body.tools } : {}),
      };
      if (thinkingBudget != null) {
        // Extended thinking enabled server-side. `temperature` is OMITTED (the
        // API rejects a custom temperature alongside thinking).
        anthropicBody.thinking = { type: "enabled", budget_tokens: thinkingBudget };
      } else {
        anthropicBody.temperature = body.temperature;
      }
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(anthropicBody),
      };
    }

    case "openai": {
      // Model-aware caching layout (mirrors ai-core OpenAIProvider): static
      // doctrine leads, history follows, per-turn dynamic context is a separate
      // system message before the last user turn — so OpenAI's automatic prefix
      // cache covers the conversation history cross-turn, not just the static
      // prefix. Google (Gemini OpenAI-compat: uncertain multi-system handling)
      // and Groq (no caching) keep the simpler front-loaded layout below.
      const openaiMessages = assembleOpenAiCachedMessages(body.system, messages);
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
