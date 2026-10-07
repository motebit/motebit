/**
 * Provider + wire-protocol seam for the bench.
 *
 * The bench is provider-pluggable the same way the product is: a BYOK vendor
 * resolves (through the product's own `resolveProviderSpec`) to one of two wire
 * protocols — Anthropic `/v1/messages` or OpenAI-compatible
 * `/chat/completions` (OpenAI, Google's compat endpoint, Groq, DeepSeek).
 * Everything protocol-shaped the direct routes need lives here, so a route is
 * written once and works on either wire:
 *
 *   - where the system prompt lives (`system` field vs. `role: "system"` messages)
 *   - which top-level keys are content/transport rather than parameters
 *   - how a tool round is continued, and how A's tool results are indexed
 *   - which header carries the credential (redacted on record, re-inserted on replay)
 *
 * Nothing here builds a request from config: route bodies are always derived
 * from A's CAPTURED request (see `params.ts`).
 */

import {
  ANTHROPIC_CANONICAL_URL,
  canonicalVendorBaseUrl,
  defaultModelForVendor,
} from "../../../packages/sdk/src/index.js";
import type { BenchProvider, WireExchange, WireProtocol } from "./types.js";
import { BENCH_PROVIDERS } from "./types.js";

export const ANTHROPIC_API_VERSION = "2023-06-01";

/** Each provider's secret — the same names the CLI reads. */
export const PROVIDER_KEY_ENV: Readonly<Record<BenchProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

export function parseProvider(value: string | undefined, flag: string): BenchProvider {
  const v = (value ?? "").trim() || "anthropic";
  if (!(BENCH_PROVIDERS as readonly string[]).includes(v)) {
    throw new Error(
      `Unknown ${flag} "${v}". Accepted: ${BENCH_PROVIDERS.join(", ")}.\n` +
        `  → These mirror the product's BYOK vendor registry (packages/sdk/src/provider-mode.ts).`,
    );
  }
  return v as BenchProvider;
}

export function protocolOf(provider: BenchProvider): WireProtocol {
  return provider === "anthropic" ? "anthropic" : "openai";
}

export function defaultModelFor(provider: BenchProvider): string {
  return defaultModelForVendor(provider);
}

export function canonicalBaseUrl(provider: BenchProvider): string {
  return provider === "anthropic" ? ANTHROPIC_CANONICAL_URL : canonicalVendorBaseUrl(provider);
}

/** Reads the provider's own secret; a missing one is a hard error naming it. */
export function requireProviderKey(
  provider: BenchProvider,
  env: Readonly<Record<string, string | undefined>> = process.env,
  role = "the model under test",
): string {
  const name = PROVIDER_KEY_ENV[provider];
  const key = env[name];
  if (key == null || key.trim().length === 0) {
    throw new Error(
      `${name} is not set, but provider "${provider}" was selected for ${role}. ` +
        `The bench makes real calls; it never runs keyless.\n` +
        `  → In CI, set the repository secret ${name}. Locally, export it.\n` +
        "  → `estimate` needs no key.",
    );
  }
  return key;
}

export function endpointFor(protocol: WireProtocol, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return protocol === "anthropic" ? `${base}/v1/messages` : `${base}/chat/completions`;
}

/** Is this fetch a model call on either wire protocol? */
export function protocolOfCall(url: string, init?: RequestInit): WireProtocol | null {
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return null;
  if (/\/v1\/messages(\?|$)/.test(url)) return "anthropic";
  if (/\/chat\/completions(\?|$)/.test(url)) return "openai";
  return null;
}

/** Headers for a request the BENCH builds (B, B″, B′ᶠ, judge). */
export function directHeaders(protocol: WireProtocol, apiKey: string): Record<string, string> {
  return protocol === "anthropic"
    ? {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      }
    : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

/** Credential-bearing headers: never written to results, re-inserted on replay. */
const SECRET_HEADERS = new Set(["x-api-key", "authorization", "x-goog-api-key", "x-proxy-token"]);
export const REDACTED = "[redacted]";

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

/**
 * B′'s headers: A's recorded headers verbatim, with the redacted credential put
 * back (same key A used). Only the credential value is re-supplied — every
 * other header (version, betas, content type) is A's own.
 */
export function replayHeaders(
  recorded: Record<string, string>,
  apiKey: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(recorded)) {
    if (v !== REDACTED) out[k] = v;
    else if (k.toLowerCase() === "authorization") out[k] = `Bearer ${apiKey}`;
    else out[k] = apiKey;
  }
  return out;
}

/** Normalize any HeadersInit to a plain record (lower-case keys preserved as given). */
export function headersRecord(h: HeadersInit | undefined): Record<string, string> {
  if (h == null) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => (out[k] = v));
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

/** Top-level keys that are conversation content or transport, never parameters. */
export function contentKeys(protocol: WireProtocol): ReadonlySet<string> {
  return protocol === "anthropic"
    ? new Set(["system", "messages", "stream"])
    : new Set(["messages", "stream"]);
}

type Msg = Record<string, unknown>;

export function messagesOf(body: Record<string, unknown>): Msg[] {
  return Array.isArray(body["messages"]) ? (body["messages"] as Msg[]) : [];
}

/**
 * A's round-1 messages split around the conversation:
 *   leadingSystem  — system-role messages before the conversation (OpenAI static doctrine)
 *   conversation   — prior turns as A sent them (after trimming; may include the trim note)
 *   trailingSystem — system-role messages right before the turn (OpenAI dynamic context)
 *   turn           — the final user message onward, verbatim
 * On the Anthropic wire the system prompt is the `system` field, so both
 * system arrays are empty.
 */
export function splitMessages(body: Record<string, unknown>): {
  leadingSystem: Msg[];
  conversation: Msg[];
  trailingSystem: Msg[];
  turn: Msg[];
} {
  const msgs = messagesOf(body);
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!["role"] === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1)
    return { leadingSystem: [], conversation: [], trailingSystem: [], turn: msgs };
  let lead = 0;
  while (lead < lastUser && msgs[lead]!["role"] === "system") lead++;
  let trail = lastUser;
  while (trail > lead && msgs[trail - 1]!["role"] === "system") trail--;
  return {
    leadingSystem: msgs.slice(0, lead),
    conversation: msgs.slice(lead, trail),
    trailingSystem: msgs.slice(trail, lastUser),
    turn: msgs.slice(lastUser),
  };
}

/** Total characters of system prompt on the request, either wire. */
export function systemPromptChars(body: Record<string, unknown>): number {
  const text = (c: unknown): string =>
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? (c as Msg[]).map((b) => (typeof b["text"] === "string" ? b["text"] : "")).join("")
        : "";
  const fieldChars = text(body["system"]).length;
  const msgChars = messagesOf(body)
    .filter((m) => m["role"] === "system")
    .reduce((n, m) => n + text(m["content"]).length, 0);
  return fieldChars + msgChars;
}

/** Is this exchange's stop a tool call the caller must answer? */
export function stoppedForTools(ex: WireExchange): boolean {
  const uses = ex.content.filter((b) => b["type"] === "tool_use");
  return uses.length > 0 && (ex.stop_reason === "tool_use" || ex.stop_reason === "tool_calls");
}

/**
 * Next round's body: the prior body plus the model's tool-calling turn and the
 * tool results, in the protocol's own shape. Anthropic content blocks go back
 * UNCHANGED (thinking signatures included — the API rejects an edited thinking
 * block on a tool continuation).
 */
export function continueWithToolResults(
  protocol: WireProtocol,
  body: Record<string, unknown>,
  ex: WireExchange,
  results: Array<{ id: string; content: unknown; is_error: boolean }>,
): Record<string, unknown> {
  const messages = messagesOf(body);
  if (protocol === "anthropic") {
    return {
      ...body,
      messages: [
        ...messages,
        { role: "assistant", content: ex.content },
        {
          role: "user",
          content: results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.content,
            ...(r.is_error ? { is_error: true } : {}),
          })),
        },
      ],
    };
  }
  const uses = ex.content.filter((b) => b["type"] === "tool_use");
  return {
    ...body,
    messages: [
      ...messages,
      {
        role: "assistant",
        content: ex.text.length > 0 ? ex.text : null,
        tool_calls: uses.map((u) => ({
          id: u["id"],
          type: "function",
          function: {
            name: u["name"],
            arguments:
              typeof u["arguments_raw"] === "string"
                ? u["arguments_raw"]
                : JSON.stringify(u["input"] ?? {}),
          },
        })),
      },
      ...results.map((r) => ({
        role: "tool",
        tool_call_id: r.id,
        content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
      })),
    ],
  };
}

/** Stable JSON (sorted keys) — the replay key for tool calls. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export interface RecordedToolResult {
  content: unknown;
  is_error?: boolean;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return { _unparsed: raw };
  }
}

/**
 * Index A's tool results by `name + canonical input`, read from A's own later
 * request bodies (the tool calls and tool results motebit sent back), on
 * either wire. B cannot run motebit's tools — that is the point — so a B tool
 * call that exactly matches one A made is answered with A's real result;
 * anything else is refused and counted.
 */
export function indexToolResults(
  requests: ReadonlyArray<Record<string, unknown>>,
): Map<string, RecordedToolResult> {
  const uses = new Map<string, { name: string; input: unknown }>();
  const out = new Map<string, RecordedToolResult>();
  const record = (id: unknown, content: unknown, isError: boolean) => {
    const use = uses.get(String(id));
    if (!use) return;
    out.set(`${use.name}:${stableStringify(use.input)}`, {
      content,
      ...(isError ? { is_error: true } : {}),
    });
  };
  for (const body of requests) {
    for (const msg of messagesOf(body)) {
      // OpenAI: calls on the assistant message, results as `tool` messages.
      if (Array.isArray(msg["tool_calls"])) {
        for (const tc of msg["tool_calls"] as Msg[]) {
          const fn = (tc["function"] ?? {}) as Msg;
          uses.set(String(tc["id"]), {
            name: String(fn["name"]),
            input: parseArgs(fn["arguments"]),
          });
        }
      }
      if (msg["role"] === "tool") record(msg["tool_call_id"], msg["content"], false);
      // Anthropic: tool_use / tool_result content blocks.
      if (!Array.isArray(msg["content"])) continue;
      for (const block of msg["content"] as Msg[]) {
        if (block["type"] === "tool_use") {
          uses.set(String(block["id"]), { name: String(block["name"]), input: block["input"] });
        } else if (block["type"] === "tool_result") {
          record(block["tool_use_id"], block["content"], block["is_error"] === true);
        }
      }
    }
  }
  return out;
}
