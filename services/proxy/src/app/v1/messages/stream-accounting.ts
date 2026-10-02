/**
 * Stream accounting for the motebit-cloud path — the pump that forwards the
 * provider's SSE stream to the client and meters what the provider consumed.
 *
 * The invariant: the identity is charged for what the provider actually
 * consumed, never less. A client abort must never make inference cheaper than
 * it was. Three consequences shape the pump:
 *
 *   1. **Meter before forwarding.** Usage is parsed from every upstream chunk
 *      BEFORE the client write is attempted, so a write that fails (abort,
 *      cancel under backpressure) never drops the usage that chunk carried.
 *
 *   2. **Drain, don't cancel.** On a client abort the pump stops writing but
 *      keeps READING upstream until the provider's final usage arrives. Where
 *      that usage lands differs by provider — Anthropic reports output last
 *      (`message_delta`), OpenAI-shaped hosts report ALL usage last — so
 *      stopping at the abort undercounts (or zeroes) the bill. Draining is
 *      exact: the generation is bounded by the `max_tokens` sent upstream, and
 *      the user pays precisely what the provider produced. The alternative,
 *      cancelling upstream, stops generation sooner but leaves output unknown,
 *      so it could only be billed at the `max_tokens` upper bound — never less
 *      than draining's exact charge, and usually far more. Exact dominates.
 *      The drain is time-boxed (`drainTimeoutMs`); if it expires, upstream is
 *      cancelled and the unknown remainder is billed at a CONSERVATIVE UPPER
 *      bound (see {@link upperBoundUsage}), logged `estimated: true`.
 *
 *   3. **The debit is never gated on KV.** The spend record and slot release
 *      are KV round-trips that can stall; each is bounded by `kvTimeoutMs` and
 *      the relay debit (the ledger of record) is sent regardless.
 *
 * The returned `settled` promise covers the whole lifecycle (drain → record →
 * release → debit); the route registers it with the platform's `waitUntil`
 * (Next's `after`) so an isolate teardown after the response closes cannot
 * drop the debit.
 */
import { calculateCostMicro, type InferenceHost } from "../../../validation";
import { extractUsage, type UsageAccumulator } from "./usage";

/**
 * @internal — timing bounds, mutable only so tests can shorten them.
 *
 * `drainTimeoutMs` stays inside Vercel's post-response `waitUntil` window so
 * the drain cannot be cut off by the platform before the debit is sent.
 */
export const ACCOUNTING_TIMINGS = {
  /** How long the pump keeps reading upstream after the client has gone. */
  drainTimeoutMs: 20_000,
  /** Bound on each spend-KV op (record, release) on the accounting path. */
  kvTimeoutMs: 2_000,
  /** Relay-debit retry backoff base (attempt × base). */
  debitBackoffMs: 250,
};

/**
 * Tokens of headroom added to the input upper bound: the provider-side prompt
 * scaffolding a request body does not spell out (e.g. Anthropic's tool-use
 * system prompt, a few hundred tokens).
 */
export const INPUT_BOUND_HEADROOM_TOKENS = 1_024;

export interface StreamAccountingOptions {
  upstream: ReadableStream<Uint8Array>;
  provider: InferenceHost;
  model: string;
  requestId: string;
  motebitId: string;
  /** Pre-stream spend already incurred for this request (auto-routing classifier). */
  extraCostMicro: number;
  /** The exact provider request body (input upper bound: tokens ≤ UTF-8 bytes). */
  providerRequestBody: string;
  /** The `max_tokens` sent upstream (output upper bound). */
  maxOutputTokens: number;
  spend: { record: (costMicro: number) => Promise<void>; release: () => Promise<void> } | null;
  debit: (costMicro: number) => Promise<void>;
}

export type EstimateReason = "drain_timeout" | "upstream_error" | "usage_missing";

/**
 * A conservative UPPER bound on what an unmetered request consumed. Reported
 * fields stay exact; only what the provider never reported is bounded:
 *
 *   - output: the `max_tokens` sent upstream (the provider cannot exceed it;
 *     extended thinking counts toward it).
 *   - input: the UTF-8 byte length of the provider request body plus headroom
 *     — byte-level BPE tokenizers emit at most one token per byte, and the
 *     body includes the system prompt, tools and JSON framing. On Anthropic it
 *     is priced as cache CREATION (1.25×, the highest input rate there) since
 *     a cache write could have happened.
 */
export function upperBoundUsage(
  provider: InferenceHost,
  usage: UsageAccumulator,
  providerRequestBody: string,
  maxOutputTokens: number,
): UsageAccumulator {
  const bounded: UsageAccumulator = { ...usage };
  if (!usage.inputReported) {
    const inputBound =
      new TextEncoder().encode(providerRequestBody).byteLength + INPUT_BOUND_HEADROOM_TOKENS;
    bounded.input = provider === "anthropic" ? 0 : inputBound;
    bounded.cacheRead = 0;
    bounded.cacheCreation = provider === "anthropic" ? inputBound : 0;
  }
  if (!usage.outputReported) bounded.output = Math.max(usage.output, maxOutputTokens);
  return bounded;
}

const TIMED_OUT = Symbol("timed-out");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** A KV op on the accounting path: bounded, and never throws. */
async function boundedKv(op: () => Promise<void>, what: string, requestId: string): Promise<void> {
  try {
    const r = await withTimeout(op(), ACCOUNTING_TIMINGS.kvTimeoutMs);
    if (r === TIMED_OUT) {
      console.warn(JSON.stringify({ event: "proxy.spend_kv_timeout", requestId, op: what }));
    }
  } catch {
    /* best-effort: the relay debit is the ledger of record */
  }
}

/**
 * Pump `upstream` to the returned `readable`, metering usage, then settle the
 * request's accounting exactly once. `settled` never rejects.
 */
export function meterStream(opts: StreamAccountingOptions): {
  readable: ReadableStream<Uint8Array>;
  settled: Promise<void>;
} {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const reader = opts.upstream.getReader();
  const decoder = new TextDecoder();
  const usage: UsageAccumulator = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  const settled = (async () => {
    let estimateReason: EstimateReason | null = null;
    let clientGone = false;
    let drainDeadline = 0;
    let buffer = "";
    const meter = (text: string, flush: boolean) => {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = flush ? "" : (lines.pop() ?? "");
      for (const line of lines) extractUsage(opts.provider, line, usage);
    };

    try {
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array> | typeof TIMED_OUT;
        try {
          result = clientGone
            ? await withTimeout(reader.read(), Math.max(0, drainDeadline - Date.now()))
            : await reader.read();
        } catch {
          estimateReason = "upstream_error";
          break;
        }
        if (result === TIMED_OUT) {
          estimateReason = "drain_timeout";
          void reader.cancel().catch(() => {});
          break;
        }
        if (result.done) {
          meter(decoder.decode(), true);
          break;
        }
        // Meter FIRST: a chunk whose client write fails still carried usage.
        meter(decoder.decode(result.value, { stream: true }), false);
        if (clientGone) continue;
        try {
          await writer.write(result.value);
        } catch {
          // The client went away. Keep draining upstream (without writing)
          // until the provider reports its final usage.
          clientGone = true;
          drainDeadline = Date.now() + ACCOUNTING_TIMINGS.drainTimeoutMs;
        }
      }
    } finally {
      await writer.close().catch(() => {});
    }

    if (estimateReason == null && !usage.outputReported) estimateReason = "usage_missing";
    const billed =
      estimateReason == null
        ? usage
        : upperBoundUsage(opts.provider, usage, opts.providerRequestBody, opts.maxOutputTokens);
    const cost =
      calculateCostMicro(
        opts.model,
        billed.input,
        billed.output,
        billed.cacheRead,
        billed.cacheCreation,
      ) + opts.extraCostMicro;
    // Normalized token fields for billing verification (`input` is UNCACHED,
    // `cacheRead` the discounted portion — additive; see usage.ts). An
    // estimated charge says so, with the reason and the bound it billed.
    console.log(
      JSON.stringify({
        event: "proxy.usage",
        requestId: opts.requestId,
        model: opts.model,
        input: billed.input,
        output: billed.output,
        cacheRead: billed.cacheRead,
        cacheCreation: billed.cacheCreation,
        costMicro: cost,
        motebitId: opts.motebitId,
        clientAborted: clientGone,
        ...(estimateReason != null
          ? {
              estimated: true,
              estimateReason,
              reported: { input: usage.input, output: usage.output },
            }
          : {}),
      }),
    );

    // Spend controls first (so the identity's next request sees this spend and
    // a free slot), each bounded so a stalled KV can never withhold the debit.
    if (opts.spend) {
      const spend = opts.spend;
      await boundedKv(() => spend.record(cost), "record", opts.requestId);
      await boundedKv(() => spend.release(), "release", opts.requestId);
    }
    if (cost > 0) {
      try {
        await opts.debit(cost);
      } catch {
        /* debitRelay never throws; defensive — `settled` must not reject */
      }
    }
  })();

  return { readable, settled };
}
