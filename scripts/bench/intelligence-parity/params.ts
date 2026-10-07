/**
 * Route bodies — every one DERIVED from A's captured request, never configured.
 *
 * The routes form pairwise contrasts, each differing from its neighbour in one
 * ingredient only:
 *
 *   A   ↔ B′   runtime/pipeline — B′ is A's captured requests replayed byte for byte
 *   B′  ↔ B″   system prompt    — B″ swaps motebit's system prompt for a neutral one
 *   B″  ↔ B    context trimming — B sends the full untrimmed conversation
 *   (B′ᶠ)      the fourth cell of the 2×2 {system} × {trimming}: motebit's system
 *              prompt + the full conversation, run only to test separability
 *
 * Parameter freezing works by EXCLUSION, not allowlist — every top-level key
 * that is not conversation content (`system`, `messages`) or transport
 * (`stream`) is a parameter. A parameter motebit starts sending tomorrow (a new
 * `output_config` field, a beta knob) is therefore frozen automatically instead
 * of being silently dropped, which would make a route "differ by" something the
 * report then misattributes.
 */

import type {
  CapturedRequest,
  FrozenParams,
  ScriptedMessage,
  WireExchange,
  WireProtocol,
} from "./types.js";
import { contentKeys, splitMessages } from "./protocol.js";

export function freezeParams(
  round1Body: Record<string, unknown>,
  protocol: WireProtocol = "anthropic",
): FrozenParams {
  const skip = contentKeys(protocol);
  const frozen: FrozenParams = {};
  for (const key of Object.keys(round1Body).sort()) {
    if (skip.has(key)) continue;
    // Deep copy: a route must not be able to mutate A's recorded request.
    frozen[key] = structuredClone(round1Body[key]);
  }
  return frozen;
}

/**
 * Deliberately minimal and neutral: no persona, no tool coaching, no format
 * rules. Anything said here is something B/B″ have that A lacks, so it says
 * nothing a bare API caller would not.
 */
export const NEUTRAL_SYSTEM_PROMPT = "You are a helpful assistant.";

function withSystem(
  protocol: WireProtocol,
  base: Record<string, unknown>,
  system: "neutral" | null,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...base };
  if (protocol === "anthropic") {
    if (system === "neutral") body["system"] = NEUTRAL_SYSTEM_PROMPT;
    body["messages"] = messages;
  } else {
    body["messages"] =
      system === "neutral"
        ? [{ role: "system", content: NEUTRAL_SYSTEM_PROMPT }, ...messages]
        : messages;
  }
  body["stream"] = true;
  return body;
}

const plain = (history: readonly ScriptedMessage[]) =>
  history.map((m) => ({ role: m.role, content: m.content }));

/** Route B round 1: A's frozen params, neutral system, the FULL untrimmed conversation. */
export function buildRouteBRequest(
  frozen: FrozenParams,
  history: readonly ScriptedMessage[],
  prompt: string,
  protocol: WireProtocol = "anthropic",
): Record<string, unknown> {
  return withSystem(protocol, structuredClone(frozen), "neutral", [
    ...plain(history),
    { role: "user", content: prompt },
  ]);
}

/**
 * Route B″ round 1: A's round-1 body with ONLY the system prompt replaced —
 * A's trimmed messages (trim note included, exactly as sent), A's params and
 * tools. On the OpenAI wire motebit's system prompt is its `system`-role
 * messages (static doctrine first, per-turn context before the turn), so those
 * are what is removed.
 */
export function buildRouteBppRequest(
  round1Body: Record<string, unknown>,
  protocol: WireProtocol = "anthropic",
): Record<string, unknown> {
  const body = structuredClone(round1Body);
  const { conversation, turn } = splitMessages(body);
  return withSystem(protocol, body, "neutral", [...conversation, ...turn]);
}

/**
 * Route B′ᶠ round 1 (the interaction cell): A's round-1 body with ONLY the
 * trimmed conversation replaced by the full untrimmed history — A's system
 * prompt, A's turn message, A's params and tools.
 */
export function buildRouteBpfRequest(
  round1Body: Record<string, unknown>,
  history: readonly ScriptedMessage[],
  protocol: WireProtocol = "anthropic",
): Record<string, unknown> {
  const body = structuredClone(round1Body);
  const { leadingSystem, trailingSystem, turn } = splitMessages(body);
  return withSystem(protocol, body, null, [
    ...leadingSystem,
    ...plain(history),
    ...trailingSystem,
    ...turn,
  ]);
}

/** Capture A's rounds for B′ — the recorded bytes, untouched. */
export function captureRequests(rounds: readonly WireExchange[]): CapturedRequest[] {
  return rounds.map((ex) => ({
    url: ex.url,
    raw: ex.request_raw,
    headers: { ...ex.request_headers },
  }));
}
