/**
 * Stream-metering BOUNDARY matrix — the sibling of `stream-metering-matrix`
 * for the inputs that decide what the provider is ALLOWED to consume and how
 * it is priced. The invariant is the same: the identity is charged for what
 * the provider actually consumed, never less; an estimate is a conservative
 * UPPER bound.
 *
 *   A. max_tokens  × absent, valid, string, negative, float, huge
 *      provider    × anthropic, openai, groq, google
 *      usage       × reported (exact), missing (bounded estimate)
 *      client      × reads, cancels, stalls (never reads, never cancels)
 *
 *   B. anthropic cache × none, 5m, 1h, split-absent (only the total reported)
 *      server-tool input growth × no, yes (message_delta reports MORE input)
 *      usage       × reported, missing
 *      client      × reads, cancels, stalls
 *
 *   C. provider served × never (only an error event / an empty 200 body),
 *                        started-then-errored (usage lost after generation began)
 *      provider    × anthropic, openai, groq, google
 *      client      × reads, cancels, stalls
 *
 *   D. request feature × unmeterable (server tools, MCP, unknown keys and
 *                        block types) — refused 400 before anything spends
 *      provider    × anthropic, openai, groq, google
 *
 *   E. google thinking (gemini-2.5-pro: thinking only in `total_tokens`)
 *      client      × reads, cancels, stalls
 *
 * C: a provider that never served bills 0 (no debit sent, logged
 * `proxy.turn_unbilled_provider_error`); one that started and lost its usage
 * bills >= the worst it could have been (the upper bound). D: 400
 * `unsupported_feature`, nothing upstream, no debit, slot released once.
 * E: output billed as total - prompt (never below completion_tokens).
 *
 * Per cell: an invalid max_tokens is refused at the boundary (400, nothing
 * sent upstream, no debit, slot released once); otherwise the value sent
 * upstream is a positive safe integer within the tier cap, there is exactly
 * one debit (one reference id, one amount), the amount is >= the provider's
 * TRUE cost for the cell (computed here independently of the route's pricing
 * code), an exact cell is not over-charged, the slot is released exactly once,
 * and the accounting settles within {@link SETTLE_BOUND_MS} (test timings).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as validation from "../validation";
import type { ProxyTokenPayload } from "../validation";

vi.mock("../validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../validation")>();
  return { ...actual, parseProxyToken: vi.fn() };
});
const afterTasks: Array<Promise<unknown>> = [];
vi.mock("next/server", () => ({
  after: vi.fn((task: Promise<unknown>) => {
    afterTasks.push(task);
  }),
}));

import { after } from "next/server";
import { POST } from "../app/v1/messages/route";
import { ACCOUNTING_TIMINGS } from "../app/v1/messages/stream-accounting";
import { setSpendStoreForTests, memorySpendStore, type SpendStore } from "../spend-controls";

const ORIGIN = "http://localhost:3000";
const PROXY = { origin: ORIGIN, "x-proxy-token": "tok", "content-type": "application/json" };
const TIER_CAP = validation.DEPOSIT_LIMITS.maxTokens;
/** What a provider generates when it receives NO cap (`max_tokens: null`). */
const UNCAPPED_OUTPUT = 65_536;
const INPUT = 1_000;
const GROWN_INPUT = 225_000;
const CACHE_WRITE = 100_000;
const SETTLE_BOUND_MS = 1_500;
const PROMPT = "word ".repeat(8_000);
const TEST_TIMINGS = {
  kvTimeoutMs: 10,
  debitBackoffMs: 1,
  drainTimeoutMs: 200,
  writeStallMs: 20,
  debitAttemptTimeoutMs: 15,
};

type Provider = "anthropic" | "openai" | "groq" | "google";
type MaxTok = "absent" | "valid" | "string" | "negative" | "float" | "huge";
type Cache = "none" | "5m" | "1h" | "split_absent";
type Usage = "reported" | "missing";
type Client = "reads" | "cancels" | "stalls";

const MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  groq: "llama-3.3-70b-versatile",
  google: "gemini-2.5-flash",
};
const GEMINI_PRO = "gemini-2.5-pro";
/** Gemini thinking tokens — billed as output, reported only in total_tokens. */
const THINKING = 3_000;
/** $/MTok, restated here so the TRUE cost is independent of the route's pricing code. */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "gpt-5.4": { input: 2.5, output: 15.0 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
};
const MAX_TOKENS: Record<MaxTok, unknown> = {
  absent: undefined,
  valid: 2_000,
  string: "abc",
  negative: -5,
  float: 100.5,
  huge: 10_000_000,
};
const INVALID: ReadonlySet<MaxTok> = new Set(["string", "negative", "float"]);

interface Truth {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

/**
 * The provider's true charge (Anthropic list pricing: 5-minute cache write
 * 1.25x input, 1-hour cache write 2x input), plus the proxy's 20% margin.
 */
function trueCostMicro(model: string, t: Truth): number {
  const r = RATES[model]!;
  const usd =
    (t.input * r.input +
      t.cacheWrite5m * r.input * 1.25 +
      t.cacheWrite1h * r.input * 2 +
      t.output * r.output) /
    1_000_000;
  return Math.ceil(usd * 1.2 * 1_000_000);
}

const enc = new TextEncoder();
const sse = (event: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify(event)}\n\n`);

function kvStore(): { store: SpendStore; calls: string[] } {
  const base = memorySpendStore();
  const calls: string[] = [];
  const store: SpendStore = {
    ...base,
    incrby: (k, n) => {
      calls.push(`incrby ${k} ${n}`);
      return base.incrby(k, n);
    },
    decr: (k) => {
      calls.push(`decr ${k}`);
      return base.decr(k);
    },
  };
  return { store, calls };
}

function token(model: string): ProxyTokenPayload {
  return {
    mid: "mote-1",
    jti: "jti-1",
    bal: 100_000_000,
    models: [model],
    iat: Date.now(),
    exp: Date.now() + 3_600_000,
  };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Served = "never_error_event" | "never_empty_body" | "started_then_error";

interface CellSpec {
  provider: Provider;
  maxTok: MaxTok;
  cache: Cache;
  growth: boolean;
  usage: Usage;
  client: Client;
  /** Axis C — absent: the provider served normally. */
  served?: Served;
  /** Axis E — gemini-2.5-pro reports thinking only in total_tokens. */
  thinking?: boolean;
  /** Axis D — extra (unmeterable) request fields. */
  feature?: Record<string, unknown>;
}

/** Upstream SSE for the cell, given the request the proxy actually sent. */
function upstreamFor(
  spec: CellSpec,
  sent: Record<string, unknown>,
): { chunks: Uint8Array[]; truth: Truth } {
  const sentMax = sent.max_tokens;
  const output =
    typeof sentMax === "number" && Number.isSafeInteger(sentMax) && sentMax > 0
      ? sentMax
      : UNCAPPED_OUTPUT;
  const bodyText = JSON.stringify(sent);
  const bodyBytes = enc.encode(bodyText).byteLength;
  const zero: Truth = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };

  if (spec.served === "never_empty_body") return { chunks: [], truth: zero };
  if (spec.served === "never_error_event") {
    return {
      chunks: [
        spec.provider === "anthropic"
          ? enc.encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
            )
          : sse({ error: { type: "server_error", code: 503, message: "unavailable" } }),
      ],
      truth: zero,
    };
  }
  if (spec.served === "started_then_error") {
    // Generation began, then the provider errored: usage for the output is
    // lost, so the true cost is the worst it could have been.
    const err =
      spec.provider === "anthropic"
        ? enc.encode(
            `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error" } })}\n\n`,
          )
        : sse({ error: { type: "server_error" } });
    return spec.provider === "anthropic"
      ? {
          chunks: [
            sse({
              type: "message_start",
              message: { usage: { input_tokens: INPUT, output_tokens: 1 } },
            }),
            sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }),
            err,
          ],
          truth: { input: INPUT, cacheWrite5m: 0, cacheWrite1h: 0, output },
        }
      : {
          chunks: [sse({ choices: [{ delta: { content: "Hi" } }] }), err],
          truth: { input: bodyBytes, cacheWrite5m: 0, cacheWrite1h: 0, output },
        };
  }
  if (spec.thinking) {
    // Real-shaped Gemini OpenAI-compat final chunk: completion_tokens omits
    // the thinking tokens, total_tokens includes them.
    const visible = Math.min(200, output);
    return {
      chunks: [
        sse({ choices: [{ delta: { content: "Hi" } }] }),
        sse({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: INPUT,
            completion_tokens: visible,
            total_tokens: INPUT + visible + THINKING,
          },
        }),
        enc.encode("data: [DONE]\n\n"),
      ],
      truth: { input: INPUT, cacheWrite5m: 0, cacheWrite1h: 0, output: visible + THINKING },
    };
  }

  if (spec.usage === "missing") {
    // The provider never reports usage: the TRUE cost is the worst it could
    // have been — every request byte a token (Anthropic: written to cache at
    // the TTL the request asked for), output generated to the cap sent.
    const text =
      spec.provider === "anthropic"
        ? [sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } })]
        : [sse({ choices: [{ delta: { content: "Hi" } }] })];
    let truth: Truth = { input: bodyBytes, cacheWrite5m: 0, cacheWrite1h: 0, output };
    if (spec.provider === "anthropic" && bodyText.includes('"cache_control"')) {
      truth = bodyText.includes('"ttl":"1h"')
        ? { input: 0, cacheWrite5m: 0, cacheWrite1h: bodyBytes, output }
        : { input: 0, cacheWrite5m: bodyBytes, cacheWrite1h: 0, output };
    }
    return { chunks: text, truth };
  }

  if (spec.provider !== "anthropic") {
    return {
      chunks: [
        sse({ choices: [{ delta: { content: "Hi" } }] }),
        sse({ choices: [{ delta: {}, finish_reason: "length" }] }),
        sse({ choices: [], usage: { prompt_tokens: INPUT, completion_tokens: output } }),
        enc.encode("data: [DONE]\n\n"),
      ],
      truth: { input: INPUT, cacheWrite5m: 0, cacheWrite1h: 0, output },
    };
  }

  const w5 = spec.cache === "5m" ? CACHE_WRITE : 0;
  const w1h = spec.cache === "1h" ? CACHE_WRITE : 0;
  const cacheUsage =
    spec.cache === "none"
      ? {}
      : {
          cache_creation_input_tokens: CACHE_WRITE,
          ...(spec.cache === "split_absent"
            ? {}
            : {
                cache_creation: {
                  ephemeral_5m_input_tokens: w5,
                  ephemeral_1h_input_tokens: w1h,
                },
              }),
        };
  const finalInput = spec.growth ? GROWN_INPUT : INPUT;
  return {
    chunks: [
      sse({
        type: "message_start",
        message: { usage: { input_tokens: INPUT, output_tokens: 1, ...cacheUsage } },
      }),
      sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }),
      sse({
        type: "message_delta",
        // Server tools (web_search) re-prompt the model: message_delta reports
        // the CUMULATIVE input, which can exceed message_start's.
        usage: {
          output_tokens: output,
          ...(spec.growth ? { input_tokens: finalInput, ...cacheUsage } : {}),
        },
      }),
      sse({ type: "message_stop" }),
    ],
    // split-absent: the TTL is unknowable from usage, so the true cost may be
    // the 1-hour rate — the bill must cover it.
    truth: {
      input: finalInput,
      cacheWrite5m: w5,
      cacheWrite1h: spec.cache === "1h" || spec.cache === "split_absent" ? CACHE_WRITE : 0,
      output,
    },
  };
}

function requestBody(spec: CellSpec, model: string): Record<string, unknown> {
  // A prompt large enough that the input bound is decided by its bytes, not
  // by the fixed headroom.
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: PROMPT }],
    ...spec.feature,
  };
  const mt = MAX_TOKENS[spec.maxTok];
  if (mt !== undefined) body.max_tokens = mt;
  if (spec.cache === "1h" || spec.cache === "split_absent") {
    body.system = [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }];
  } else if (spec.cache === "5m") {
    body.system = [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }];
  }
  return body;
}

async function runCell(spec: CellSpec) {
  const model = spec.thinking ? GEMINI_PRO : MODEL[spec.provider];
  const { store, calls } = kvStore();
  setSpendStoreForTests(store);
  vi.mocked(validation.parseProxyToken).mockResolvedValue(token(model));

  const debits: Array<{ amount: number; reference_id: string }> = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  let truth: Truth | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/debit")) {
        debits.push(JSON.parse(init?.body as string) as { amount: number; reference_id: string });
        return new Response("{}", { status: 200 });
      }
      const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
      sentBodies.push(sent);
      const up = upstreamFor(spec, sent);
      truth = up.truth;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of up.chunks) c.enqueue(ch);
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }),
  );

  const res = await POST(
    new Request("https://proxy.example/v1/messages", {
      method: "POST",
      headers: PROXY,
      body: JSON.stringify(requestBody(spec, model)),
    }),
  );

  if (res.status === 200) {
    const client = res.body!.getReader();
    if (spec.client === "reads") {
      for (;;) if ((await client.read()).done) break;
    } else if (spec.client === "cancels") {
      await client.read();
      await client.cancel();
    } // "stalls": never reads, never cancels.

    expect(afterTasks).toHaveLength(1);
    const settledInBound = await Promise.race([
      afterTasks[0]!.then(() => true),
      tick(SETTLE_BOUND_MS).then(() => false),
    ]);
    expect(settledInBound, `accounting did not settle within ${SETTLE_BOUND_MS}ms`).toBe(true);
  }

  return { res, debits, sentBodies, calls, model, truth: truth as Truth | null };
}

function loggedEvents(name: string): Array<Record<string, unknown>> {
  return [console.log, console.warn, console.error]
    .flatMap((f) => vi.mocked(f).mock.calls.map((c) => String(c[0])))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e?.event === name);
}

const PROVIDERS: Provider[] = ["anthropic", "openai", "groq", "google"];
const MAXTOKS: MaxTok[] = ["absent", "valid", "string", "negative", "float", "huge"];
const CACHES: Cache[] = ["none", "5m", "1h", "split_absent"];
const USAGES: Usage[] = ["reported", "missing"];
const CLIENTS: Client[] = ["reads", "cancels", "stalls"];

const A_CELLS: CellSpec[] = PROVIDERS.flatMap((provider) =>
  MAXTOKS.flatMap((maxTok) =>
    USAGES.flatMap((usage) =>
      CLIENTS.map((client) => ({
        provider,
        maxTok,
        cache: "none" as const,
        growth: false,
        usage,
        client,
      })),
    ),
  ),
);
const B_CELLS: CellSpec[] = CACHES.flatMap((cache) =>
  [false, true].flatMap((growth) =>
    USAGES.flatMap((usage) =>
      CLIENTS.map((client) => ({
        provider: "anthropic" as const,
        maxTok: "absent" as const,
        cache,
        growth,
        usage,
        client,
      })),
    ),
  ),
);

const SERVED: Served[] = ["never_error_event", "never_empty_body", "started_then_error"];
const base = {
  maxTok: "absent" as const,
  cache: "none" as const,
  growth: false,
  usage: "reported" as const,
};
const C_CELLS: CellSpec[] = PROVIDERS.flatMap((provider) =>
  SERVED.flatMap((served) => CLIENTS.map((client) => ({ ...base, provider, served, client }))),
);
const FEATURES: Array<[string, Record<string, unknown>]> = [
  ["web_search", { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] }],
  ["web_fetch", { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }],
  ["code_execution", { tools: [{ type: "code_execution_20250825", name: "code_execution" }] }],
  ["mcp_servers", { mcp_servers: [{ type: "url", url: "https://mcp.example", name: "m" }] }],
  ["container", { container: "container_123" }],
  [
    "server_tool_use block",
    {
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }],
        },
        { role: "user", content: "more" },
      ],
    },
  ],
  [
    "file document source",
    {
      messages: [
        {
          role: "user",
          content: [{ type: "document", source: { type: "file", file_id: "file_1" } }],
        },
      ],
    },
  ],
];
const D_CELLS: Array<[string, CellSpec]> = PROVIDERS.flatMap((provider) =>
  FEATURES.map(
    ([f, feature]) =>
      [`${provider} · feature=${f}`, { ...base, provider, client: "reads" as const, feature }] as [
        string,
        CellSpec,
      ],
  ),
);
const E_CELLS: CellSpec[] = CLIENTS.map((client) => ({
  ...base,
  provider: "google" as const,
  thinking: true,
  client,
}));

const name = (c: CellSpec) =>
  `${c.provider} · max_tokens=${c.maxTok} · cache=${c.cache} · growth=${c.growth ? "yes" : "no"} · usage=${c.usage} · client=${c.client}`;

describe("stream metering boundary matrix — charged for what the provider consumed, never less", () => {
  const saved = { ...ACCOUNTING_TIMINGS };
  beforeAll(() => {
    Object.assign(ACCOUNTING_TIMINGS, TEST_TIMINGS);
  });
  afterAll(() => {
    Object.assign(ACCOUNTING_TIMINGS, saved);
  });
  beforeEach(() => {
    afterTasks.length = 0;
    process.env.RELAY_PUBLIC_KEY = "test-pubkey";
    process.env.RELAY_PROXY_SECRET = "relay-secret-test";
    // Billing must be configured for motebit-cloud to serve at all (billing.ts).
    process.env.RELAY_API_URL = "https://relay.test";
    process.env.ANTHROPIC_API_KEY = "sk-a";
    process.env.OPENAI_API_KEY = "sk-o";
    process.env.GROQ_API_KEY = "sk-g";
    process.env.GOOGLE_AI_API_KEY = "sk-gg";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setSpendStoreForTests(undefined);
    for (const k of [
      "RELAY_PROXY_SECRET",
      "RELAY_API_URL",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "GOOGLE_AI_API_KEY",
    ])
      delete process.env[k];
  });

  it("the restated rates match the route's price table", () => {
    for (const [model, r] of Object.entries(RATES)) {
      expect(validation.calculateCostMicro(model, 1_000_000, 0)).toBe(
        Math.ceil(r.input * 1.2 * 1_000_000),
      );
      expect(validation.calculateCostMicro(model, 0, 1_000_000)).toBe(
        Math.ceil(r.output * 1.2 * 1_000_000),
      );
    }
  });

  it.each([...A_CELLS, ...B_CELLS].map((c) => [name(c), c] as const))("%s", async (_n, spec) => {
    const { res, debits, sentBodies, calls, model, truth } = await runCell(spec);

    // The slot is released exactly once on every path.
    expect(calls.filter((c) => c === "decr proxy:active:mote-1")).toHaveLength(1);

    if (INVALID.has(spec.maxTok)) {
      // Refused at the boundary: nothing reached the provider, nothing debited.
      expect(res.status).toBe(400);
      expect(sentBodies).toHaveLength(0);
      expect(debits).toHaveLength(0);
      expect(calls.filter((c) => c.startsWith("incrby proxy:spent:"))).toHaveLength(0);
      return;
    }

    expect(res.status).toBe(200);
    expect(sentBodies).toHaveLength(1);
    const sentMax = sentBodies[0]!.max_tokens;
    expect(Number.isSafeInteger(sentMax) && (sentMax as number) > 0).toBe(true);
    expect(sentMax as number).toBeLessThanOrEqual(TIER_CAP);
    if (spec.maxTok === "valid") expect(sentMax).toBe(MAX_TOKENS.valid);

    // Exactly one logical debit, never below the provider's true cost.
    const want = trueCostMicro(model, truth!);
    expect(debits).toHaveLength(1);
    const amount = debits[0]!.amount;
    expect(amount).toBeGreaterThanOrEqual(want);
    // An exact cell (usage reported, TTL known) is not over-charged.
    if (spec.usage === "reported" && spec.cache !== "split_absent") {
      expect(amount).toBeLessThanOrEqual(want + 1);
    }
    expect(calls.filter((c) => c.startsWith("incrby proxy:spent:"))).toEqual([
      `incrby proxy:spent:jti-1 ${amount}`,
    ]);
  });

  it.each(
    C_CELLS.map((c) => [`${c.provider} · served=${c.served} · client=${c.client}`, c] as const),
  )("%s", async (_n, spec) => {
    const { res, debits, sentBodies, calls, model, truth } = await runCell(spec);
    expect(res.status).toBe(200);
    expect(sentBodies).toHaveLength(1);
    expect(calls.filter((c) => c === "decr proxy:active:mote-1")).toHaveLength(1);
    const unbilled = loggedEvents("proxy.turn_unbilled_provider_error");

    if (spec.served !== "started_then_error") {
      // The provider never served: it billed nothing, so neither does the turn.
      expect(debits).toHaveLength(0);
      expect(calls.filter((c) => /^incrby proxy:spent:\S+ [1-9]/.test(c))).toHaveLength(0);
      expect(unbilled).toHaveLength(1);
      expect(unbilled[0]!.providerErrorType).toBe(
        spec.served === "never_empty_body"
          ? "empty_body"
          : spec.provider === "anthropic"
            ? "overloaded_error"
            : "server_error",
      );
      return;
    }
    // Generation started: the lost usage is billed at the upper bound.
    expect(unbilled).toHaveLength(0);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBeGreaterThanOrEqual(trueCostMicro(model, truth!));
  });

  it.each(D_CELLS)("%s → 400 unsupported_feature before anything spends", async (_n, spec) => {
    const { res, debits, sentBodies, calls } = await runCell(spec);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_feature");
    expect(sentBodies).toHaveLength(0);
    expect(debits).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("incrby proxy:spent:"))).toHaveLength(0);
    expect(calls.filter((c) => c === "decr proxy:active:mote-1")).toHaveLength(1);
  });

  it.each(
    E_CELLS.map((c) => [`google · gemini-2.5-pro thinking · client=${c.client}`, c] as const),
  )("%s — output billed incl. thinking (total - prompt), exact", async (_n, spec) => {
    const { res, debits, model, truth } = await runCell(spec);
    expect(res.status).toBe(200);
    const want = trueCostMicro(model, truth!);
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amount).toBeGreaterThanOrEqual(want);
    expect(debits[0]!.amount).toBeLessThanOrEqual(want + 1);
  });

  it("an `after` that throws is logged proxy.accounting_unregistered (error) and the debit still lands", async () => {
    vi.mocked(after).mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const model = MODEL.anthropic;
    const { store, calls } = kvStore();
    setSpendStoreForTests(store);
    vi.mocked(validation.parseProxyToken).mockResolvedValue(token(model));
    const debits: number[] = [];
    let truth: Truth | null = null;
    const spec: CellSpec = { ...base, provider: "anthropic", client: "reads" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/debit")) {
          debits.push((JSON.parse(init?.body as string) as { amount: number }).amount);
          return new Response("{}", { status: 200 });
        }
        const up = upstreamFor(spec, JSON.parse(init?.body as string) as Record<string, unknown>);
        truth = up.truth;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              for (const ch of up.chunks) c.enqueue(ch);
              c.close();
            },
          }),
          { status: 200 },
        );
      }),
    );
    const res = await POST(
      new Request("https://proxy.example/v1/messages", {
        method: "POST",
        headers: PROXY,
        body: JSON.stringify(requestBody(spec, model)),
      }),
    );
    await res.text(); // the client reads to EOF — the debit lands before it

    const unregistered = loggedEvents("proxy.accounting_unregistered");
    expect(unregistered).toHaveLength(1);
    expect(unregistered[0]!.motebitId).toBe("mote-1");
    expect(unregistered[0]!.requestId).toBe(res.headers.get("X-Motebit-Request-Id"));
    expect(
      vi
        .mocked(console.error)
        .mock.calls.some((c) => String(c[0]).includes('"proxy.accounting_unregistered"')),
    ).toBe(true);
    expect(debits).toEqual([trueCostMicro(model, truth!)]);
    expect(calls.filter((c) => c === "decr proxy:active:mote-1")).toHaveLength(1);
  });
});
