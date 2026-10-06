/**
 * Routes B and B′ — the same model called straight at the provider API.
 *
 * Raw `fetch` against `/v1/messages`, deliberately: it is the same wire
 * protocol `AnthropicProvider` speaks, the body is built from A's frozen
 * parameters (see `params.ts`), and the call travels through the same wire tap
 * as A so both routes are timed and token-counted by one instrument. An SDK
 * client would add its own defaults and retries — exactly the kind of
 * unrecorded difference this bench exists to rule out.
 */

import { addUsage, ZERO_USAGE, type WireTap } from "./wire-tap.js";
import { stableStringify, type RecordedToolResult } from "./params.js";
import type { DirectRouteResult, FrozenParams, Usage, WireExchange } from "./types.js";

export const ANTHROPIC_API_VERSION = "2023-06-01";
/** A's runtime caps its own loop; B gets the same ceiling so neither can out-loop the other. */
export const MAX_DIRECT_ROUNDS = 10;

export interface DirectRouteInput {
  route: "B" | "Bp";
  prompt_id: string;
  repetition: number;
  apiKey: string;
  baseUrl: string;
  /** Round-1 body (already carries the frozen params). */
  body: Record<string, unknown>;
  params: FrozenParams;
  toolResults: Map<string, RecordedToolResult>;
  tap: WireTap;
  clock?: () => number;
}

async function send(input: DirectRouteInput, body: Record<string, unknown>): Promise<WireExchange> {
  const mark = input.tap.exchanges.length;
  const res = await input.tap.fetch(`${input.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify(body),
  });
  // Drain our branch; the tap parses its own.
  await res.text();
  await input.tap.settled();
  const ex = input.tap.exchanges[mark];
  if (!ex) throw new Error("wire tap did not observe the direct call — is it installed?");
  if (!res.ok) throw new Error(ex.error ?? `HTTP ${res.status}`);
  return ex;
}

export async function runDirectRoute(input: DirectRouteInput): Promise<DirectRouteResult> {
  const clock = input.clock ?? (() => performance.now());
  const start = clock();
  let usage: Usage = { ...ZERO_USAGE };
  const requests: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const replay = { replayed: 0, unavailable: 0 };
  let firstTextAt: number | undefined;
  let answer = "";
  let body = structuredClone(input.body);
  let rounds = 0;
  let error: string | undefined;

  try {
    for (; rounds < MAX_DIRECT_ROUNDS;) {
      requests.push(body);
      const ex = await send(input, body);
      rounds += 1;
      usage = addUsage(usage, ex.usage);
      if (firstTextAt === undefined && ex.first_text_at !== undefined) {
        firstTextAt = ex.first_text_at;
      }
      answer += ex.text;
      const uses = ex.content.filter((b) => b["type"] === "tool_use");
      if (ex.stop_reason !== "tool_use" || uses.length === 0) break;

      const results = uses.map((u) => {
        const name = String(u["name"]);
        toolCalls.push({ name, input: u["input"] });
        const hit = input.toolResults.get(`${name}:${stableStringify(u["input"])}`);
        if (hit) replay.replayed += 1;
        else replay.unavailable += 1;
        return {
          type: "tool_result",
          tool_use_id: u["id"],
          content: hit
            ? hit.content
            : "Tool result unavailable on this route: no identical call was made on the motebit route to replay.",
          ...(hit?.is_error === true || !hit ? { is_error: true } : {}),
        };
      });
      const messages = body["messages"] as Array<Record<string, unknown>>;
      body = {
        ...body,
        // Content blocks go back UNCHANGED (thinking signatures included) —
        // the API rejects an edited thinking block on a tool continuation.
        messages: [
          ...messages,
          { role: "assistant", content: ex.content },
          { role: "user", content: results },
        ],
      };
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    route: input.route,
    prompt_id: input.prompt_id,
    repetition: input.repetition,
    answer: answer.trim(),
    ttft_ms: firstTextAt !== undefined ? firstTextAt - start : null,
    total_ms: clock() - start,
    usage,
    model_rounds: rounds,
    tool_calls: toolCalls,
    requests,
    params: input.params,
    tool_replay: replay,
    ...(error !== undefined ? { error } : {}),
  };
}
