/**
 * Parameter freezing — the bench's attribution guarantee.
 *
 * B and B′ are only comparable to A if they send the SAME model with the SAME
 * provider parameters. So nothing here is configured for B: its parameters are
 * COPIED from A's round-1 request body as it was observed on the wire. The
 * split is by exclusion, not by allowlist — every top-level key that is not
 * conversation content (`system`, `messages`) or transport (`stream`) is a
 * parameter. A parameter motebit starts sending tomorrow (a new `output_config`
 * field, a beta knob) is therefore frozen automatically instead of being
 * silently dropped from B, which would make B "differ by" something the report
 * then misattributes to motebit's prompt.
 */

import type { FrozenParams, ScriptedMessage } from "./types.js";

/** Keys that are conversation content or transport, never parameters. */
export const CONTENT_KEYS: ReadonlySet<string> = new Set(["system", "messages", "stream"]);

export function freezeParams(round1Body: Record<string, unknown>): FrozenParams {
  const frozen: FrozenParams = {};
  for (const key of Object.keys(round1Body).sort()) {
    if (CONTENT_KEYS.has(key)) continue;
    // Deep copy: B must not be able to mutate A's recorded request.
    frozen[key] = structuredClone(round1Body[key]);
  }
  return frozen;
}

/**
 * Deliberately minimal and neutral: no persona, no tool coaching, no format
 * rules. Anything said here is something B has that A lacks, so it says
 * nothing a bare API caller would not.
 */
export const NEUTRAL_SYSTEM_PROMPT = "You are a helpful assistant.";

/** Route B round 1: A's frozen params, neutral system, the FULL untrimmed conversation. */
export function buildRouteBRequest(
  frozen: FrozenParams,
  history: readonly ScriptedMessage[],
  prompt: string,
): Record<string, unknown> {
  return {
    ...structuredClone(frozen),
    system: NEUTRAL_SYSTEM_PROMPT,
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: prompt },
    ],
    stream: true,
  };
}

/**
 * Route B′ round 1: A's round-1 body replayed VERBATIM — motebit's exact system
 * prompt, exact trimmed messages, exact params — sent straight to the API. A − B′
 * is then pure pipeline time (memory, events, context assembly, runtime); B′ − B
 * is pure prompt/context effect.
 */
export function buildRouteBpRequest(round1Body: Record<string, unknown>): Record<string, unknown> {
  return { ...structuredClone(round1Body), stream: true };
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

/**
 * Index A's tool results by `name + canonical input`, read from A's own later
 * request bodies (the assistant `tool_use` blocks and the user `tool_result`
 * blocks motebit sent back). B cannot run motebit's tools — that is the point —
 * so a B tool call that exactly matches one A made is answered with A's real
 * result; anything else is refused and counted.
 */
export function indexToolResults(
  requests: ReadonlyArray<Record<string, unknown>>,
): Map<string, RecordedToolResult> {
  const uses = new Map<string, { name: string; input: unknown }>();
  const out = new Map<string, RecordedToolResult>();
  for (const body of requests) {
    const messages = Array.isArray(body["messages"])
      ? (body["messages"] as Array<Record<string, unknown>>)
      : [];
    for (const msg of messages) {
      if (!Array.isArray(msg["content"])) continue;
      for (const block of msg["content"] as Array<Record<string, unknown>>) {
        if (block["type"] === "tool_use") {
          uses.set(String(block["id"]), { name: String(block["name"]), input: block["input"] });
        } else if (block["type"] === "tool_result") {
          const use = uses.get(String(block["tool_use_id"]));
          if (!use) continue;
          out.set(`${use.name}:${stableStringify(use.input)}`, {
            content: block["content"],
            ...(block["is_error"] === true ? { is_error: true } : {}),
          });
        }
      }
    }
  }
  return out;
}
