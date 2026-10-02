/**
 * meterStream — the bounded paths. Where the provider's final usage is not
 * obtainable (the drain timed out, upstream errored, or it never reported),
 * the charge is a CONSERVATIVE UPPER bound and the usage event says so.
 * The exact paths are covered cell by cell in `stream-metering-matrix.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  meterStream,
  upperBoundUsage,
  ACCOUNTING_TIMINGS,
  INPUT_BOUND_HEADROOM_TOKENS,
  type StreamAccountingOptions,
} from "../stream-accounting";
import { calculateCostMicro } from "../../../../validation";

const enc = new TextEncoder();
const sse = (event: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify(event)}\n\n`);
const BODY = JSON.stringify({
  model: "m",
  max_tokens: 2_000,
  messages: [{ role: "user", content: "hi" }],
});
const BODY_BYTES = enc.encode(BODY).byteLength;

let logs: Array<Record<string, unknown>>;
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(JSON.parse(String(line)) as Record<string, unknown>);
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function controlled() {
  let c!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start: (ctl) => void (c = ctl),
    cancel: () => void (cancelled = true),
  });
  return { upstream, ctl: () => c, cancelled: () => cancelled };
}

function run(over: Partial<StreamAccountingOptions> & Pick<StreamAccountingOptions, "upstream">) {
  const debits: number[] = [];
  const recorded: number[] = [];
  let releases = 0;
  const out = meterStream({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    requestId: "req-1",
    motebitId: "mote-1",
    extraCostMicro: 0,
    providerRequestBody: BODY,
    maxOutputTokens: 2_000,
    spend: {
      record: async (c) => void recorded.push(c),
      release: async () => void releases++,
    },
    debit: async (c) => void debits.push(c),
    ...over,
  });
  return { ...out, debits, recorded, releases: () => releases };
}

describe("upperBoundUsage", () => {
  it("keeps reported input exact and bounds only the unreported output at max_tokens", () => {
    const b = upperBoundUsage(
      "anthropic",
      { input: 1_000, output: 1, cacheRead: 30, cacheCreation: 5, inputReported: true },
      BODY,
      2_000,
    );
    expect(b).toMatchObject({ input: 1_000, cacheRead: 30, cacheCreation: 5, output: 2_000 });
  });

  it("bounds unreported input by request bytes + headroom (Anthropic: at the 1.25× cache-write rate)", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const bound = BODY_BYTES + INPUT_BOUND_HEADROOM_TOKENS;
    expect(upperBoundUsage("anthropic", zero, BODY, 2_000)).toMatchObject({
      input: 0,
      cacheCreation: bound,
      output: 2_000,
    });
    expect(upperBoundUsage("openai", zero, BODY, 2_000)).toMatchObject({
      input: bound,
      cacheCreation: 0,
      output: 2_000,
    });
  });

  it("is never below any exact charge it could replace", () => {
    const exact = calculateCostMicro("claude-sonnet-4-6", 1_000, 1_999, 0, 0);
    const b = upperBoundUsage(
      "anthropic",
      { input: 1_000, output: 10, cacheRead: 0, cacheCreation: 0, inputReported: true },
      BODY,
      2_000,
    );
    expect(
      calculateCostMicro("claude-sonnet-4-6", b.input, b.output, b.cacheRead, b.cacheCreation),
    ).toBeGreaterThanOrEqual(exact);
  });
});

describe("meterStream — bounded, logged estimates", () => {
  it("drain timeout after a client abort: cancels upstream and charges the upper bound, logged estimated", async () => {
    const saved = ACCOUNTING_TIMINGS.drainTimeoutMs;
    ACCOUNTING_TIMINGS.drainTimeoutMs = 20;
    try {
      const { upstream, ctl, cancelled } = controlled();
      const r = run({ upstream });
      const client = r.readable.getReader();
      ctl().enqueue(sse({ type: "message_start", message: { usage: { input_tokens: 1_000 } } }));
      expect((await client.read()).done).toBe(false);
      await client.cancel();
      ctl().enqueue(sse({ type: "content_block_delta" })); // the write that discovers the abort
      // ...and upstream then stalls: no message_delta ever arrives.
      await r.settled;
      await new Promise((res) => setTimeout(res, 1));
      expect(cancelled()).toBe(true);

      const expected = calculateCostMicro("claude-sonnet-4-6", 1_000, 2_000, 0, 0);
      expect(r.debits).toEqual([expected]);
      expect(r.recorded).toEqual([expected]);
      expect(r.releases()).toBe(1);
      expect(logs).toEqual([
        expect.objectContaining({
          event: "proxy.usage",
          costMicro: expected,
          estimated: true,
          estimateReason: "drain_timeout",
          clientAborted: true,
          reported: { input: 1_000, output: 0 },
        }),
      ]);
    } finally {
      ACCOUNTING_TIMINGS.drainTimeoutMs = saved;
    }
  });

  it("upstream error mid-stream: charges the upper bound (the provider may have generated to max_tokens)", async () => {
    const { upstream, ctl } = controlled();
    const r = run({ upstream });
    void r.readable.pipeTo(new WritableStream());
    ctl().enqueue(sse({ type: "message_start", message: { usage: { input_tokens: 1_000 } } }));
    await new Promise((res) => setTimeout(res, 1));
    ctl().error(new Error("upstream reset"));
    await r.settled;
    expect(r.debits).toEqual([calculateCostMicro("claude-sonnet-4-6", 1_000, 2_000, 0, 0)]);
    expect(logs[0]).toMatchObject({ estimated: true, estimateReason: "upstream_error" });
  });

  it("a stream that ends without final usage is never billed as free", async () => {
    const r = run({
      provider: "openai",
      model: "gpt-5.4",
      upstream: new ReadableStream({
        start(c) {
          c.enqueue(sse({ choices: [{ delta: { content: "hi" } }] }));
          c.close();
        },
      }),
    });
    void r.readable.pipeTo(new WritableStream());
    await r.settled;
    const bound = BODY_BYTES + INPUT_BOUND_HEADROOM_TOKENS;
    expect(r.debits).toEqual([calculateCostMicro("gpt-5.4", bound, 2_000, 0, 0)]);
    expect(logs[0]).toMatchObject({ estimated: true, estimateReason: "usage_missing" });
  });

  it("exact usage is logged without an estimate flag, and meters a final line that has no trailing newline", async () => {
    const r = run({
      upstream: new ReadableStream({
        start(c) {
          c.enqueue(sse({ type: "message_start", message: { usage: { input_tokens: 10 } } }));
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } })}`,
            ),
          );
          c.close();
        },
      }),
    });
    void r.readable.pipeTo(new WritableStream());
    await r.settled;
    expect(r.debits).toEqual([calculateCostMicro("claude-sonnet-4-6", 10, 3, 0, 0)]);
    expect(logs[0]).not.toHaveProperty("estimated");
  });

  it("a hung spend KV is bounded: the debit is still sent", async () => {
    const saved = ACCOUNTING_TIMINGS.kvTimeoutMs;
    ACCOUNTING_TIMINGS.kvTimeoutMs = 5;
    try {
      const r = run({
        spend: { record: () => new Promise(() => {}), release: () => new Promise(() => {}) },
        upstream: new ReadableStream({
          start(c) {
            c.enqueue(sse({ type: "message_start", message: { usage: { input_tokens: 10 } } }));
            c.enqueue(sse({ type: "message_delta", usage: { output_tokens: 3 } }));
            c.close();
          },
        }),
      });
      void r.readable.pipeTo(new WritableStream());
      await r.settled;
      expect(r.debits).toEqual([calculateCostMicro("claude-sonnet-4-6", 10, 3, 0, 0)]);
    } finally {
      ACCOUNTING_TIMINGS.kvTimeoutMs = saved;
    }
  });
});
