/**
 * Stream-metering matrix — the money invariant of the motebit-cloud stream
 * pump, asserted over every combination that has broken it:
 *
 *   provider    × anthropic (usage split: input first, output last)
 *               × openai / groq (ALL usage in the final chunk)
 *   abort point × none, before the first chunk, mid-stream, after the text but
 *                 before the usage, after the last chunk but before close,
 *                 under backpressure (a client that never read)
 *   relay debit × ok, 500, throw, slow
 *   spend KV    × ok, slow, hang (record/release never settle)
 *
 * For EVERY cell: exactly one logical debit (one reference id, one amount),
 * the amount equals the provider-reported usage cost (exact metering — the
 * upstream always finishes here, so usage is always obtainable), the
 * concurrency slot is released exactly once, and the spend recorded against
 * the token is the amount debited. A client abort must never make inference
 * cheaper than the provider made it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as validation from "../validation";
import type { ProxyTokenPayload } from "../validation";

vi.mock("../validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../validation")>();
  return { ...actual, parseProxyToken: vi.fn() };
});
// Capture what the route registers with the platform's waitUntil (`after`).
const afterTasks: Array<Promise<unknown>> = [];
vi.mock("next/server", () => ({
  after: vi.fn((task: Promise<unknown>) => {
    afterTasks.push(task);
  }),
}));

import { POST, DEBIT_MAX_ATTEMPTS } from "../app/v1/messages/route";
import { ACCOUNTING_TIMINGS } from "../app/v1/messages/stream-accounting";
import { setSpendStoreForTests, memorySpendStore, type SpendStore } from "../spend-controls";

const ORIGIN = "http://localhost:3000";
const PROXY = { origin: ORIGIN, "x-proxy-token": "tok", "content-type": "application/json" };
const INPUT = 1_000;
const OUTPUT = 500;

type Provider = "anthropic" | "openai" | "groq";
type Abort =
  | "none"
  | "before_first_chunk"
  | "mid_stream"
  | "after_text_before_usage"
  | "after_last_chunk_before_close"
  | "backpressure";
type Debit = "ok" | "500" | "throw" | "slow";
type Kv = "ok" | "slow" | "hang";

const MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  groq: "llama-3.3-70b-versatile",
};

const enc = new TextEncoder();
const sse = (event: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify(event)}\n\n`);

/** Upstream chunks, split into the text phase and the usage-bearing tail. */
function upstreamChunks(p: Provider): { text: Uint8Array[]; tail: Uint8Array[] } {
  if (p === "anthropic") {
    return {
      text: [
        sse({
          type: "message_start",
          message: { usage: { input_tokens: INPUT, output_tokens: 1 } },
        }),
        sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } }),
        sse({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } }),
      ],
      tail: [
        sse({ type: "message_delta", usage: { output_tokens: OUTPUT } }),
        sse({ type: "message_stop" }),
      ],
    };
  }
  return {
    text: [
      sse({ choices: [{ delta: { content: "Hel" } }] }),
      sse({ choices: [{ delta: { content: "lo" } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ],
    tail: [
      sse({ choices: [], usage: { prompt_tokens: INPUT, completion_tokens: OUTPUT } }),
      enc.encode("data: [DONE]\n\n"),
    ],
  };
}

/** Memory store whose post-admission ops (record = incrby, release = decr) follow `kv`. */
function kvStore(kv: Kv): { store: SpendStore; map: Map<string, number>; calls: string[] } {
  const base = memorySpendStore();
  const calls: string[] = [];
  const gate = <T>(p: () => Promise<T>): Promise<T> => {
    if (kv === "hang") return new Promise<T>(() => {});
    if (kv === "slow") return new Promise<T>((r) => setTimeout(() => void p().then(r), 30));
    return p();
  };
  const store: SpendStore = {
    ...base,
    incrby: (k, n) => {
      calls.push(`incrby ${k} ${n}`);
      return gate(() => base.incrby(k, n));
    },
    decr: (k) => {
      calls.push(`decr ${k}`);
      return gate(() => base.decr(k));
    },
  };
  return { store, map: base.map, calls };
}

interface DebitCall {
  amount: number;
  reference_id: string;
}

function token(model: string): ProxyTokenPayload {
  return {
    mid: "mote-1",
    jti: "jti-1",
    bal: 10_000_000,
    models: [model],
    iat: Date.now(),
    exp: Date.now() + 3_600_000,
  };
}

/** console.error lines this cell (the debit-failure reconciliation trail). */
let errors: string[] = [];

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function runCell(provider: Provider, abort: Abort, debit: Debit, kv: Kv) {
  const model = MODEL[provider];
  const { store, map, calls } = kvStore(kv);
  setSpendStoreForTests(store);
  vi.mocked(validation.parseProxyToken).mockResolvedValue(token(model));

  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      upstream = c;
    },
  });
  const debits: DebitCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/debit")) {
        debits.push(JSON.parse(init?.body as string) as DebitCall);
        if (debit === "throw") throw new TypeError("relay unreachable");
        if (debit === "500") return new Response("{}", { status: 500 });
        if (debit === "slow") await tick(40);
        return new Response("{}", { status: 200 });
      }
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }),
  );

  const res = await POST(
    new Request("https://proxy.example/v1/messages", {
      method: "POST",
      headers: PROXY,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  expect(res.status).toBe(200);
  const client = res.body!.getReader();
  const { text, tail } = upstreamChunks(provider);
  const all = [...text, ...tail];
  const readN = async (n: number) => {
    for (let i = 0; i < n; i++) expect((await client.read()).done).toBe(false);
  };

  switch (abort) {
    case "none":
      for (const c of all) upstream.enqueue(c);
      upstream.close();
      for (;;) if ((await client.read()).done) break;
      break;
    case "before_first_chunk":
      await client.cancel();
      for (const c of all) upstream.enqueue(c);
      upstream.close();
      break;
    case "mid_stream":
      upstream.enqueue(text[0]!);
      await readN(1);
      await client.cancel();
      for (const c of all.slice(1)) upstream.enqueue(c);
      upstream.close();
      break;
    case "after_text_before_usage":
      for (const c of text) upstream.enqueue(c);
      await readN(text.length);
      await client.cancel();
      for (const c of tail) upstream.enqueue(c);
      upstream.close();
      break;
    case "after_last_chunk_before_close":
      for (const c of all) upstream.enqueue(c);
      await readN(all.length);
      await client.cancel();
      upstream.close();
      break;
    case "backpressure":
      // The client never reads: every pump write is held by backpressure.
      for (const c of all) upstream.enqueue(c);
      upstream.close();
      await tick(5);
      await client.cancel();
      break;
  }

  // Completion: the accounting task the route registered with the platform's
  // waitUntil. Everything asserted below happened INSIDE that task, so an
  // isolate teardown after it resolves cannot drop any of it.
  expect(afterTasks).toHaveLength(1);
  await afterTasks[0];
  if (kv === "slow") await tick(50); // the bounded KV ops land after their timeout

  return { debits, map, calls, model };
}

const PROVIDERS: Provider[] = ["anthropic", "openai", "groq"];
const ABORTS: Abort[] = [
  "none",
  "before_first_chunk",
  "mid_stream",
  "after_text_before_usage",
  "after_last_chunk_before_close",
  "backpressure",
];
const DEBITS: Debit[] = ["ok", "500", "throw", "slow"];
const KVS: Kv[] = ["ok", "slow", "hang"];
const CELLS = PROVIDERS.flatMap((p) =>
  ABORTS.flatMap((a) => DEBITS.flatMap((d) => KVS.map((k) => [p, a, d, k] as const))),
);

describe("stream metering matrix — charged for what the provider consumed, never less", () => {
  const saved = { ...ACCOUNTING_TIMINGS };
  beforeAll(() => {
    // Real timers, shortened bounds: the cells run in milliseconds.
    ACCOUNTING_TIMINGS.kvTimeoutMs = 10;
    ACCOUNTING_TIMINGS.debitBackoffMs = 1;
  });
  afterAll(() => {
    Object.assign(ACCOUNTING_TIMINGS, saved);
  });
  beforeEach(() => {
    afterTasks.length = 0;
    errors = [];
    process.env.RELAY_PUBLIC_KEY = "test-pubkey";
    process.env.RELAY_PROXY_SECRET = "relay-secret-test";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.GROQ_API_KEY = "sk-g";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setSpendStoreForTests(undefined);
    for (const k of ["RELAY_PROXY_SECRET", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY"])
      delete process.env[k];
  });

  it.each(CELLS)("%s · abort=%s · debit=%s · kv=%s", async (provider, abort, debit, kv) => {
    const { debits, map, calls, model } = await runCell(provider, abort, debit, kv);
    const expected = validation.calculateCostMicro(model, INPUT, OUTPUT, 0, 0);
    expect(expected).toBeGreaterThan(0);

    // Exactly one logical debit, for the full provider-reported usage.
    expect(debits.length).toBeGreaterThan(0);
    expect(new Set(debits.map((d) => d.reference_id)).size).toBe(1);
    expect(new Set(debits.map((d) => d.amount))).toEqual(new Set([expected]));
    if (debit === "500" || debit === "throw") {
      expect(debits).toHaveLength(DEBIT_MAX_ATTEMPTS);
      const failed = errors.map((e) => JSON.parse(e) as Record<string, unknown>);
      expect(failed).toEqual([
        expect.objectContaining({ event: "proxy.debit_failed", amountMicro: expected }),
      ]);
    } else {
      expect(debits).toHaveLength(1);
    }

    // The slot is released exactly once; the recorded spend is the debit.
    expect(calls.filter((c) => c === "decr proxy:active:mote-1")).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("incrby proxy:spent:"))).toEqual([
      `incrby proxy:spent:jti-1 ${expected}`,
    ]);
    if (kv !== "hang") {
      expect(map.get("proxy:spent:jti-1")).toBe(expected);
      expect(map.get("proxy:active:mote-1")).toBe(0);
    }
  });
});
