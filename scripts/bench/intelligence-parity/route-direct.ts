/**
 * Direct routes — the same model called straight at the provider API.
 *
 *   B, B″, B′ᶠ  `runDirectRoute`: a round-1 body DERIVED from A's captured
 *               request (see `params.ts`), then the protocol's own tool loop,
 *               answering tool calls with A's recorded results.
 *   B′          `runReplayRoute`: A's captured requests replayed BYTE FOR BYTE —
 *               the exact body string, URL and headers A's adapter handed to
 *               `fetch` (only the redacted credential is re-supplied). Nothing
 *               is re-serialized, so A ↔ B′ differs only by the runtime.
 *
 * Raw `fetch`, deliberately: an SDK client would add its own defaults and
 * retries — exactly the kind of unrecorded difference this bench exists to rule
 * out. Every call travels through the same wire tap as A, so all routes are
 * timed and token-counted by one instrument.
 */

import { addUsage, ZERO_USAGE, type WireTap } from "./wire-tap.js";
import {
  continueWithToolResults,
  directHeaders,
  endpointFor,
  replayHeaders,
  stableStringify,
  stoppedForTools,
  type RecordedToolResult,
} from "./protocol.js";
import type {
  CapturedRequest,
  DirectRouteId,
  DirectRouteResult,
  FrozenParams,
  Usage,
  WireExchange,
  WireProtocol,
} from "./types.js";

export { ANTHROPIC_API_VERSION } from "./protocol.js";
/** A's runtime caps its own loop; B gets the same ceiling so neither can out-loop the other. */
export const MAX_DIRECT_ROUNDS = 10;

interface Common {
  prompt_id: string;
  repetition: number;
  apiKey: string;
  tap: WireTap;
  clock?: () => number;
}

export interface DirectRouteInput extends Common {
  route: Exclude<DirectRouteId, "Bp">;
  protocol?: WireProtocol;
  baseUrl: string;
  /** Round-1 body (already carries the frozen params). */
  body: Record<string, unknown>;
  params: FrozenParams;
  toolResults: Map<string, RecordedToolResult>;
}

export interface ReplayRouteInput extends Common {
  /** A's in-turn requests as captured at the transport seam, in order. */
  captured: readonly CapturedRequest[];
  /** Did A's round k stop for a tool call? Same length as `captured`. */
  aStoppedForTools: readonly boolean[];
  params: FrozenParams;
}

async function send(
  tap: WireTap,
  url: string,
  headers: Record<string, string>,
  raw: string,
): Promise<WireExchange> {
  const mark = tap.exchanges.length;
  const res = await tap.fetch(url, { method: "POST", headers, body: raw });
  // Drain our branch; the tap parses its own.
  await res.text();
  await tap.settled();
  const ex = tap.exchanges[mark];
  if (!ex) throw new Error("wire tap did not observe the direct call — is it installed?");
  if (!res.ok) throw new Error(ex.error ?? `HTTP ${res.status}`);
  return ex;
}

interface Accumulator {
  usage: Usage;
  requests: Array<Record<string, unknown>>;
  toolCalls: Array<{ name: string; input: unknown }>;
  firstTextAt: number | undefined;
  answer: string;
  rounds: number;
}

function absorb(acc: Accumulator, ex: WireExchange): void {
  acc.rounds += 1;
  acc.usage = addUsage(acc.usage, ex.usage);
  if (acc.firstTextAt === undefined && ex.first_text_at !== undefined) {
    acc.firstTextAt = ex.first_text_at;
  }
  acc.answer += ex.text;
  for (const b of ex.content) {
    if (b["type"] === "tool_use")
      acc.toolCalls.push({ name: String(b["name"]), input: b["input"] });
  }
}

const fresh = (): Accumulator => ({
  usage: { ...ZERO_USAGE },
  requests: [],
  toolCalls: [],
  firstTextAt: undefined,
  answer: "",
  rounds: 0,
});

export async function runDirectRoute(input: DirectRouteInput): Promise<DirectRouteResult> {
  const protocol = input.protocol ?? "anthropic";
  const clock = input.clock ?? (() => performance.now());
  const url = endpointFor(protocol, input.baseUrl);
  const headers = directHeaders(protocol, input.apiKey);
  const start = clock();
  const acc = fresh();
  const replay = { replayed: 0, unavailable: 0 };
  let body = structuredClone(input.body);
  let error: string | undefined;

  try {
    while (acc.rounds < MAX_DIRECT_ROUNDS) {
      acc.requests.push(body);
      const ex = await send(input.tap, url, headers, JSON.stringify(body));
      absorb(acc, ex);
      if (!stoppedForTools(ex)) break;
      const results = ex.content
        .filter((b) => b["type"] === "tool_use")
        .map((u) => {
          const hit = input.toolResults.get(`${String(u["name"])}:${stableStringify(u["input"])}`);
          if (hit) replay.replayed += 1;
          else replay.unavailable += 1;
          return {
            id: String(u["id"]),
            content: hit
              ? hit.content
              : "Tool result unavailable on this route: no identical call was made on the motebit route to replay.",
            is_error: hit ? hit.is_error === true : true,
          };
        });
      body = continueWithToolResults(protocol, body, ex, results);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    route: input.route,
    prompt_id: input.prompt_id,
    repetition: input.repetition,
    answer: acc.answer.trim(),
    ttft_ms: acc.firstTextAt !== undefined ? acc.firstTextAt - start : null,
    total_ms: clock() - start,
    usage: acc.usage,
    model_rounds: acc.rounds,
    tool_calls: acc.toolCalls,
    requests: acc.requests,
    params: input.params,
    tool_replay: replay,
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * B′: send A's captured requests, in order, exactly as captured. Round k+1 is
 * A's own round k+1 (carrying A's tool results), so no tool is re-run and no
 * body is rebuilt. If the replayed model's stop behaviour on round k differs
 * from A's (it answers where A called a tool, or vice versa), the rest of A's
 * trajectory no longer follows from this conversation: replay stops there and
 * the divergence is recorded rather than papered over.
 */
export async function runReplayRoute(input: ReplayRouteInput): Promise<DirectRouteResult> {
  const clock = input.clock ?? (() => performance.now());
  const start = clock();
  const acc = fresh();
  let diverged: number | undefined;
  let error: string | undefined;

  try {
    for (let k = 0; k < input.captured.length; k++) {
      const req = input.captured[k]!;
      const ex = await send(input.tap, req.url, replayHeaders(req.headers, input.apiKey), req.raw);
      acc.requests.push(ex.request_body);
      absorb(acc, ex);
      const replayedTool = stoppedForTools(ex);
      const aTool = input.aStoppedForTools[k] ?? false;
      if (replayedTool !== aTool) {
        diverged = k + 1;
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    route: "Bp",
    prompt_id: input.prompt_id,
    repetition: input.repetition,
    answer: acc.answer.trim(),
    ttft_ms: acc.firstTextAt !== undefined ? acc.firstTextAt - start : null,
    total_ms: clock() - start,
    usage: acc.usage,
    model_rounds: acc.rounds,
    tool_calls: acc.toolCalls,
    requests: acc.requests,
    params: input.params,
    tool_replay: { replayed: 0, unavailable: 0 },
    ...(diverged !== undefined ? { diverged_at_round: diverged } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
