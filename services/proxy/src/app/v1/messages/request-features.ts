/**
 * Request-feature allowlist for the metered (motebit-cloud) path — pure logic,
 * extracted from the edge route so it can be unit-tested against the real
 * client request builders.
 *
 * The metering principle: charge exactly what the provider billed, once; when
 * that cannot be known, a logged conservative upper bound. A request feature
 * whose cost the stream's `usage` does not report — Anthropic server tools
 * (web_search / web_fetch / code_execution: input that grows after
 * `message_start`, per-use fees no usage field carries), MCP connectors,
 * containers, Files-API references — cannot be metered, so it is REFUSED
 * (400 `unsupported_feature`, before the classifier or the provider spends)
 * rather than under-billed. The boundary is DENY BY DEFAULT: only the
 * features listed here pass; a new provider feature is unsupported until it
 * is added here with its metering argument.
 *
 * What passes, and why it meters:
 *   - top level: `model`, `messages`, `system`, `max_tokens` (the output
 *     bound), `stream`, `temperature` / `top_p` / `top_k`, `stop_sequences`,
 *     `metadata`, `tools`, `thinking` (thinking tokens are reported in the
 *     provider's output usage — Anthropic `output_tokens`, OpenAI
 *     `completion_tokens`, Gemini `total_tokens`; usage.ts).
 *   - tools: client tools only — Anthropic custom (`type` absent or
 *     `"custom"`: name / description / input_schema / cache_control) or
 *     OpenAI `type: "function"`. The model's tool call is output tokens; the
 *     tool runs on the client.
 *   - content blocks: `text`, `image`, `document` (base64 / text / url
 *     sources — priced as input tokens), and the conversation-replay blocks
 *     `tool_use`, `tool_result` (nested text / image / document only),
 *     `thinking`, `redacted_thinking`. `cache_control` is priced by TTL.
 */

/** A refused feature: `feature` names it, `path` locates it in the request. */
export interface UnsupportedFeature {
  feature: string;
  path: string;
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
  "tools",
  "thinking",
]);

const MESSAGE_KEYS: ReadonlySet<string> = new Set(["role", "content"]);

/** Allowed keys per content-block type (`type` itself is always allowed). */
const BLOCK_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  text: new Set(["text", "cache_control"]),
  image: new Set(["source", "cache_control"]),
  document: new Set(["source", "title", "context", "cache_control"]),
  tool_use: new Set(["id", "name", "input", "cache_control"]),
  tool_result: new Set(["tool_use_id", "content", "is_error", "cache_control"]),
  thinking: new Set(["thinking", "signature"]),
  redacted_thinking: new Set(["data"]),
};

/** Block types a `tool_result` may nest. */
const TOOL_RESULT_BLOCKS: ReadonlySet<string> = new Set(["text", "image", "document"]);
/** Block types a `system` array may carry. */
const SYSTEM_BLOCKS: ReadonlySet<string> = new Set(["text"]);

const IMAGE_SOURCES: ReadonlySet<string> = new Set(["base64", "url"]);
const DOCUMENT_SOURCES: ReadonlySet<string> = new Set(["base64", "text", "url"]);

const CUSTOM_TOOL_KEYS: ReadonlySet<string> = new Set([
  "type",
  "name",
  "description",
  "input_schema",
  "cache_control",
]);
const FUNCTION_TOOL_KEYS: ReadonlySet<string> = new Set(["type", "function"]);
const FUNCTION_KEYS: ReadonlySet<string> = new Set(["name", "description", "parameters", "strict"]);

const THINKING_TYPES: ReadonlySet<string> = new Set(["enabled", "disabled", "adaptive"]);
const THINKING_KEYS: ReadonlySet<string> = new Set(["type", "budget_tokens"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A refused value, named for the error: primitives verbatim, anything else by its type. */
const label = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : v === null
      ? "null"
      : typeof v;

function unknownKey(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  what: string,
  typed = true,
): UnsupportedFeature | null {
  for (const k of Object.keys(obj)) {
    if (!(typed && k === "type") && !allowed.has(k))
      return { feature: `${what}.${k}`, path: `${path}.${k}` };
  }
  return null;
}

function checkCacheControl(v: unknown, path: string): UnsupportedFeature | null {
  if (v === undefined) return null;
  if (!isObject(v) || v.type !== "ephemeral") {
    return { feature: "cache_control", path };
  }
  const extra = unknownKey(v, new Set(["ttl"]), path, "cache_control");
  if (extra) return extra;
  if (v.ttl !== undefined && v.ttl !== "5m" && v.ttl !== "1h") {
    return { feature: `cache_control.ttl=${label(v.ttl)}`, path: `${path}.ttl` };
  }
  return null;
}

function checkBlock(
  block: unknown,
  allowedTypes: ReadonlySet<string> | null,
  path: string,
): UnsupportedFeature | null {
  if (!isObject(block) || typeof block.type !== "string") {
    return { feature: "content_block", path };
  }
  const type = block.type;
  // Own keys only: a block `type` of "constructor" / "__proto__" is unknown.
  const keys = Object.hasOwn(BLOCK_KEYS, type) ? BLOCK_KEYS[type] : undefined;
  if (keys === undefined || (allowedTypes !== null && !allowedTypes.has(type))) {
    return { feature: `content.type=${type}`, path: `${path}.type` };
  }
  const extra = unknownKey(block, keys, path, `content[${type}]`);
  if (extra) return extra;
  const cc = checkCacheControl(block.cache_control, `${path}.cache_control`);
  if (cc) return cc;

  if (type === "image" || type === "document") {
    const source = block.source;
    const sources = type === "image" ? IMAGE_SOURCES : DOCUMENT_SOURCES;
    if (!isObject(source) || typeof source.type !== "string" || !sources.has(source.type)) {
      const t = isObject(source) ? label(source.type) : typeof source;
      return { feature: `${type}.source.type=${t}`, path: `${path}.source` };
    }
  }
  if (type === "tool_result" && Array.isArray(block.content)) {
    for (let i = 0; i < block.content.length; i++) {
      const bad = checkBlock(block.content[i], TOOL_RESULT_BLOCKS, `${path}.content[${i}]`);
      if (bad) return bad;
    }
  } else if (type === "tool_result" && block.content != null) {
    if (typeof block.content !== "string") {
      return { feature: "tool_result.content", path: `${path}.content` };
    }
  }
  return null;
}

function checkTool(tool: unknown, path: string): UnsupportedFeature | null {
  if (!isObject(tool)) return { feature: "tool", path };
  const type = tool.type;
  if (type === undefined || type === "custom") {
    const extra = unknownKey(tool, CUSTOM_TOOL_KEYS, path, "tool");
    if (extra) return extra;
    if (typeof tool.name !== "string") return { feature: "tool.name", path: `${path}.name` };
    return checkCacheControl(tool.cache_control, `${path}.cache_control`);
  }
  if (type === "function") {
    const extra = unknownKey(tool, FUNCTION_TOOL_KEYS, path, "tool");
    if (extra) return extra;
    const fn = tool.function;
    if (!isObject(fn) || typeof fn.name !== "string") {
      return { feature: "tool.function", path: `${path}.function` };
    }
    return unknownKey(fn, FUNCTION_KEYS, `${path}.function`, "tool.function");
  }
  // Server tools (web_search_*, web_fetch_*, code_execution_*, computer_*, …).
  return { feature: `tools.type=${label(type)}`, path: `${path}.type` };
}

/**
 * The first request feature the proxy cannot meter, or null when every
 * feature in `body` is on the allowlist. Shape errors the route validates on
 * its own (`messages`, `max_tokens`, `model`) are left to it.
 */
export function findUnsupportedFeature(body: Record<string, unknown>): UnsupportedFeature | null {
  for (const k of Object.keys(body)) {
    if (!TOP_LEVEL_KEYS.has(k)) return { feature: k, path: k };
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return { feature: "stream", path: "stream" };
  }
  for (const k of ["temperature", "top_p", "top_k"] as const) {
    if (body[k] !== undefined && body[k] !== null && typeof body[k] !== "number") {
      return { feature: k, path: k };
    }
  }
  if (
    body.stop_sequences !== undefined &&
    !(Array.isArray(body.stop_sequences) && body.stop_sequences.every((s) => typeof s === "string"))
  ) {
    return { feature: "stop_sequences", path: "stop_sequences" };
  }
  if (body.metadata !== undefined) {
    if (!isObject(body.metadata)) return { feature: "metadata", path: "metadata" };
    const extra = unknownKey(body.metadata, new Set(["user_id"]), "metadata", "metadata", false);
    if (extra) return extra;
  }
  if (body.thinking !== undefined) {
    const t = body.thinking;
    if (!isObject(t) || typeof t.type !== "string" || !THINKING_TYPES.has(t.type)) {
      const tt = isObject(t) ? label(t.type) : typeof t;
      return { feature: `thinking.type=${tt}`, path: "thinking.type" };
    }
    const extra = unknownKey(t, THINKING_KEYS, "thinking", "thinking");
    if (extra) return extra;
  }

  if (body.system !== undefined && typeof body.system !== "string") {
    if (!Array.isArray(body.system)) return { feature: "system", path: "system" };
    for (let i = 0; i < body.system.length; i++) {
      const bad = checkBlock(body.system[i], SYSTEM_BLOCKS, `system[${i}]`);
      if (bad) return bad;
    }
  }

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return { feature: "tools", path: "tools" };
    for (let i = 0; i < body.tools.length; i++) {
      const bad = checkTool(body.tools[i], `tools[${i}]`);
      if (bad) return bad;
    }
  }

  if (Array.isArray(body.messages)) {
    const messages: unknown[] = body.messages;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!isObject(m)) continue; // the route's message validation owns shape
      const extra = unknownKey(m, MESSAGE_KEYS, `messages[${i}]`, "message", false);
      if (extra) return extra;
      if (!Array.isArray(m.content)) continue;
      for (let j = 0; j < m.content.length; j++) {
        const bad = checkBlock(m.content[j], null, `messages[${i}].content[${j}]`);
        if (bad) return bad;
      }
    }
  }
  return null;
}
