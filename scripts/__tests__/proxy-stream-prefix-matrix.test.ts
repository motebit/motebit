/**
 * Stream-prefix × stream-ending billing matrix, end to end: every way a
 * provider's 200 stream can begin, crossed with every way it can end, driven
 * through the REAL relay in-process + the REAL proxy `POST` (the same rig as
 * `proxy-debit-lands.test.ts`; only the provider is faked).
 *
 * Why a table and not another case: the "provider never served" class was
 * found twice by enumerating stream SHAPES (an error event, an empty body),
 * and each fix added one more shape to a list — leaving a reset before any
 * byte, an SSE comment, a ping, a non-SSE JSON error body all billed the
 * ~303k-micro upper bound. Here the expected bill of every cell is derived
 * from ONE rule, never from the shape:
 *
 *   - no generation started (Anthropic `message_start` / any OpenAI-shaped
 *     chunk with `choices`) AND no usage reported  ⇒ provider cost 0, logged
 *     `proxy.turn_unbilled_provider_error` with a reason (a spent classifier
 *     is still billed, once);
 *   - a usage field reported                       ⇒ that field exact;
 *   - started and a field never reported           ⇒ that field at the
 *     conservative upper bound (input: request bytes + headroom — on
 *     Anthropic priced as a 1-hour cache write; output: the `max_tokens`
 *     sent upstream), logged `estimated: true`.
 *
 * The OpenAI-shaped role-only first chunk is the equivalent of Anthropic's
 * `message_start`: the provider has begun the response, so it counts as
 * started.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../../services/relay/src/index.js";
import { AUTH_HEADER, createTestRelay } from "../../services/relay/src/__tests__/test-helpers.js";
import { POST } from "../../services/proxy/src/app/v1/messages/route.js";
import { calculateCostMicro, CLASSIFIER_MODEL } from "../../services/proxy/src/validation.js";
import {
  ACCOUNTING_TIMINGS,
  INPUT_BOUND_HEADROOM_TOKENS,
} from "../../services/proxy/src/app/v1/messages/stream-accounting.js";
import {
  memorySpendStore,
  setSpendStoreForTests,
} from "../../services/proxy/src/spend-controls.js";

const ORIGIN = "http://localhost:3000";
const RELAY_URL = "http://relay.internal.test";
const SECRET = "proxy-relay-shared-secret-test";
const FUNDED = 5_000_000;
const INPUT = 1000;
const OUTPUT = 500;
const CLASSIFIER_USAGE = { input_tokens: 120, output_tokens: 2 };

type Host = "anthropic" | "openai" | "google";
type Ending = "clean" | "reset" | "hang";

/** What a prefix proves, per the one rule — never what it looks like. */
interface PrefixState {
  started: boolean;
  input?: number;
  output?: number;
}

interface Prefix {
  name: string;
  chunks: Array<string | Uint8Array>;
  state: PrefixState;
  contentType?: string;
}

const sse = (event: string | null, data: unknown): string =>
  `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

const GARBAGE = new Uint8Array([0xff, 0xfe, 0x00, 0x13, 0x37, 0x0a, 0xc3, 0x28, 0x0a]);

const A_START_NO_USAGE = sse("message_start", { type: "message_start", message: { id: "m" } });
const A_START = sse("message_start", {
  type: "message_start",
  message: { usage: { input_tokens: INPUT, output_tokens: 1 } },
});
const A_DELTA = sse("content_block_delta", {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "hi" },
});
const A_USAGE = sse("message_delta", {
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: OUTPUT },
});
const A_STOP = sse("message_stop", { type: "message_stop" });

const ANTHROPIC_PREFIXES: Prefix[] = [
  { name: "zero bytes", chunks: [], state: { started: false } },
  { name: "SSE comment only", chunks: [": keep-alive\n\n"], state: { started: false } },
  { name: "ping only", chunks: [sse("ping", { type: "ping" })], state: { started: false } },
  {
    name: "event:error only",
    chunks: [
      sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    ],
    state: { started: false },
  },
  {
    name: "non-SSE JSON error body",
    chunks: [
      JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal error" } }),
    ],
    state: { started: false },
    contentType: "application/json",
  },
  { name: "garbage bytes", chunks: [GARBAGE], state: { started: false } },
  { name: "message_start without usage", chunks: [A_START_NO_USAGE], state: { started: true } },
  { name: "message_start with usage", chunks: [A_START], state: { started: true, input: INPUT } },
  {
    name: "message_start + content delta",
    chunks: [A_START, A_DELTA],
    state: { started: true, input: INPUT },
  },
  {
    name: "+ message_delta usage",
    chunks: [A_START, A_DELTA, A_USAGE],
    state: { started: true, input: INPUT, output: OUTPUT },
  },
  {
    name: "full message_stop",
    chunks: [A_START, A_DELTA, A_USAGE, A_STOP],
    state: { started: true, input: INPUT, output: OUTPUT },
  },
];

const O_ROLE = sse(null, {
  id: "c",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
});
const O_CONTENT = sse(null, {
  id: "c",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content: "hi" } }],
});
const O_USAGE = sse(null, {
  id: "c",
  object: "chat.completion.chunk",
  choices: [],
  usage: { prompt_tokens: INPUT, completion_tokens: OUTPUT, total_tokens: INPUT + OUTPUT },
});
const O_DONE = sse(null, "[DONE]");

const OPENAI_SHAPED_PREFIXES: Prefix[] = [
  { name: "zero bytes", chunks: [], state: { started: false } },
  { name: "SSE comment only", chunks: [": keep-alive\n\n"], state: { started: false } },
  {
    name: "error chunk only",
    chunks: [sse(null, { error: { message: "overloaded", type: "server_error", code: 503 } })],
    state: { started: false },
  },
  {
    name: "non-SSE JSON error body",
    chunks: [JSON.stringify({ error: { message: "internal", type: "server_error" } })],
    state: { started: false },
    contentType: "application/json",
  },
  { name: "garbage bytes", chunks: [GARBAGE], state: { started: false } },
  { name: "role-only chunk", chunks: [O_ROLE], state: { started: true } },
  { name: "content chunk", chunks: [O_ROLE, O_CONTENT], state: { started: true } },
  {
    name: "usage chunk",
    chunks: [O_ROLE, O_CONTENT, O_USAGE],
    state: { started: true, input: INPUT, output: OUTPUT },
  },
  {
    name: "[DONE]",
    chunks: [O_ROLE, O_CONTENT, O_USAGE, O_DONE],
    state: { started: true, input: INPUT, output: OUTPUT },
  },
];

const HOSTS: Array<{ host: Host; model: string; url: string; prefixes: Prefix[] }> = [
  {
    host: "anthropic",
    model: "claude-sonnet-4-6",
    url: "https://api.anthropic.com",
    prefixes: ANTHROPIC_PREFIXES,
  },
  {
    host: "openai",
    model: "gpt-5.4-mini",
    url: "https://api.openai.com",
    prefixes: OPENAI_SHAPED_PREFIXES,
  },
  {
    host: "google",
    model: "gemini-2.5-flash",
    url: "https://generativelanguage.googleapis.com",
    prefixes: OPENAI_SHAPED_PREFIXES,
  },
];
const ENDINGS: Ending[] = ["clean", "reset", "hang"];

let relay: SyncRelay;
let logs: string[];
/** The cell's provider stream: what to send and how it ends. */
let cell: { prefix: Prefix; ending: Ending };
/** The exact provider request the proxy sent (its bytes bound the input). */
let providerRequest: { url: string; body: string } | null;
let classifierCalls: number;
let savedDrain: number;

function providerStream(): Response {
  const enc = new TextEncoder();
  const queue = cell.prefix.chunks.map((c) => (typeof c === "string" ? enc.encode(c) : c));
  // Pull-driven, so the ending happens only AFTER the prefix was delivered
  // (an error raised up front would discard the queued prefix).
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = queue.shift();
        if (next) return controller.enqueue(next);
        if (cell.ending === "clean") return controller.close();
        if (cell.ending === "reset") return controller.error(new TypeError("ECONNRESET"));
        return new Promise<void>(() => {}); // "hang": only the drain deadline ends it
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: 200,
    headers: { "content-type": cell.prefix.contentType ?? "text/event-stream" },
  });
}

async function fundedIdentityToken(): Promise<{ mid: string; token: string }> {
  const created = await relay.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const mid = ((await created.json()) as { motebit_id: string }).motebit_id;
  const minted = await relay.app.request(`/api/v1/agents/${mid}/proxy-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
  });
  expect(minted.status).toBe(200);
  return { mid, token: ((await minted.json()) as { token: string }).token };
}

function fees(mid: string): number[] {
  return (
    relay.moteDb.db
      .prepare("SELECT amount FROM relay_transactions WHERE motebit_id = ? AND type = 'fee'")
      .all(mid) as Array<{ amount: number }>
  ).map((r) => r.amount);
}

function events(name: string, requestId: string): Record<string, unknown>[] {
  return logs
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (e): e is Record<string, unknown> =>
        e != null && e.event === name && e.requestId === requestId,
    );
}

async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

/** The one rule, applied to a cell: the provider's share of the bill. */
function expectedProviderCost(host: Host, model: string, state: PrefixState): number {
  if (!state.started && state.input === undefined && state.output === undefined) return 0;
  const req = providerRequest!;
  const inputBound = new TextEncoder().encode(req.body).byteLength + INPUT_BOUND_HEADROOM_TOKENS;
  const maxTokens = (JSON.parse(req.body) as { max_tokens: number }).max_tokens;
  const output = state.output ?? maxTokens;
  if (state.input !== undefined) return calculateCostMicro(model, state.input, output, 0, 0);
  return host === "anthropic"
    ? calculateCostMicro(model, 0, output, 0, 0, inputBound)
    : calculateCostMicro(model, inputBound, output, 0, 0);
}

async function runCell(
  host: Host,
  model: string,
  ending: Ending,
): Promise<{ mid: string; requestId: string }> {
  const { mid, token } = await fundedIdentityToken();
  const res = await POST(
    new Request("http://proxy.test/v1/messages", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-proxy-token": token },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
    }),
  );
  expect(res.status).toBe(200);
  const requestId = res.headers.get("X-Motebit-Request-Id")!;
  if (ending === "hang") {
    // The client gives up on a stream that never ends; the pump must then
    // drain to its deadline and settle on its own.
    await res.body!.cancel();
  } else {
    await res.text();
  }
  // Every settlement ends in exactly one debit event (landed, or a counted
  // failure such as `no_billable_amount` for a zero bill).
  const settledOnce = await until(
    () =>
      events("proxy.debit_landed", requestId).length +
        events("proxy.debit_failed", requestId).length >
      0,
  );
  expect(settledOnce, `${host} × ${cell.prefix.name} × ${ending}: never settled`).toBe(true);
  expect(
    events("proxy.debit_landed", requestId).length + events("proxy.debit_failed", requestId).length,
  ).toBe(1);
  return { mid, requestId };
}

beforeAll(async () => {
  process.env.RELAY_PROXY_SECRET = SECRET;
  // Every identity is funded through the welcome-credit grant at mint. The
  // relay reads these knobs once, at boot. One shared relay mints ~120 funded
  // identities: lift the per-IP / daily caps.
  process.env.MOTEBIT_FREE_CREDIT_USD = String(FUNDED / 1_000_000);
  process.env.MOTEBIT_FREE_CREDIT_IP_DAILY_CAP = "100000";
  process.env.MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD = "100000";
  relay = await createTestRelay();
  savedDrain = ACCOUNTING_TIMINGS.drainTimeoutMs;
  ACCOUNTING_TIMINGS.drainTimeoutMs = 40;
});

afterAll(async () => {
  ACCOUNTING_TIMINGS.drainTimeoutMs = savedDrain;
  delete process.env.RELAY_PROXY_SECRET;
  await relay.close();
});

beforeEach(() => {
  process.env.RELAY_PROXY_SECRET = SECRET;
  process.env.RELAY_PUBLIC_KEY = relay.relayIdentity.publicKeyHex;
  process.env.RELAY_API_URL = RELAY_URL;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-real";
  process.env.OPENAI_API_KEY = "sk-openai-test-never-real";
  process.env.GOOGLE_AI_API_KEY = "google-test-never-real";
  process.env.GROQ_API_KEY = "groq-test-never-real";
  setSpendStoreForTests(memorySpendStore());
  providerRequest = null;
  classifierCalls = 0;
  logs = [];
  const sink = (s: unknown) => void logs.push(String(s));
  vi.spyOn(console, "error").mockImplementation(sink);
  vi.spyOn(console, "log").mockImplementation(sink);
  vi.spyOn(console, "warn").mockImplementation(sink);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(RELAY_URL)) return relay.app.request(url.slice(RELAY_URL.length), init);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.startsWith("https://api.anthropic.com")) {
      const parsed = JSON.parse(body) as { model?: string; stream?: boolean };
      if (parsed.model === CLASSIFIER_MODEL && parsed.stream !== true) {
        classifierCalls++;
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "chat" }], usage: CLASSIFIER_USAGE }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }
    if (HOSTS.some((h) => url.startsWith(h.url))) {
      providerRequest = { url, body };
      return providerStream();
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
});

afterEach(() => {
  setSpendStoreForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of [
    "RELAY_PUBLIC_KEY",
    "RELAY_API_URL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GROQ_API_KEY",
    "MOTEBIT_FREE_CREDIT_USD",
    "MOTEBIT_FREE_CREDIT_IP_DAILY_CAP",
    "MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD",
  ]) {
    delete process.env[k];
  }
});

for (const { host, model, prefixes } of HOSTS) {
  describe(`${host} stream prefix × ending`, () => {
    for (const prefix of prefixes) {
      for (const ending of ENDINGS) {
        it(`${prefix.name} × ${ending}`, async () => {
          cell = { prefix, ending };
          const { mid, requestId } = await runCell(host, model, ending);
          expect(providerRequest?.url.startsWith(HOSTS.find((h) => h.host === host)!.url)).toBe(
            true,
          );

          const providerCost = expectedProviderCost(host, model, prefix.state);
          const billed = fees(mid).reduce((s, a) => s - a, 0);
          expect(billed, `${host} × ${prefix.name} × ${ending}`).toBe(providerCost);

          const unbilled = events("proxy.turn_unbilled_provider_error", requestId);
          const usageEvents = events("proxy.usage", requestId);
          expect(usageEvents).toHaveLength(1);
          if (providerCost === 0) {
            expect(unbilled).toHaveLength(1);
            expect(typeof unbilled[0]!.providerErrorType).toBe("string");
            expect(unbilled[0]!.providerErrorType).not.toBe("");
            expect(usageEvents[0]!.estimated).toBeUndefined();
          } else {
            expect(unbilled).toHaveLength(0);
            const lost = prefix.state.input === undefined || prefix.state.output === undefined;
            if (lost) expect(usageEvents[0]!.estimated).toBe(true);
            if (!lost && ending === "clean") expect(usageEvents[0]!.estimated).toBeUndefined();
          }
        });
      }
    }
  });
}

describe("a spent classifier is billed exactly once, whatever the provider stream did", () => {
  const classifierCost = calculateCostMicro(
    CLASSIFIER_MODEL,
    CLASSIFIER_USAGE.input_tokens,
    CLASSIFIER_USAGE.output_tokens,
  );
  const auto: Array<[number, Ending]> = [
    [0, "clean"], // zero bytes
    [0, "reset"],
    [2, "hang"], // ping only
    [3, "clean"], // event:error only
    [4, "reset"], // non-SSE JSON error
    [6, "reset"], // started, usage lost
    [10, "clean"], // full stream
  ];
  for (const [i, ending] of auto) {
    const prefix = ANTHROPIC_PREFIXES[i]!;
    it(`auto × ${prefix.name} × ${ending}`, async () => {
      // Only the Anthropic key: the auto-router lands on an Anthropic model.
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_AI_API_KEY;
      delete process.env.GROQ_API_KEY;
      cell = { prefix, ending };
      const { mid, requestId } = await runCell("anthropic", "auto", ending);
      expect(classifierCalls).toBe(1);
      expect(providerRequest?.url.startsWith("https://api.anthropic.com")).toBe(true);
      const routed = (JSON.parse(providerRequest!.body) as { model: string }).model;

      const rows = fees(mid);
      expect(rows).toHaveLength(1);
      expect(-rows[0]!).toBe(
        expectedProviderCost("anthropic", routed, prefix.state) + classifierCost,
      );
      if (!prefix.state.started) {
        const unbilled = events("proxy.turn_unbilled_provider_error", requestId);
        expect(unbilled).toHaveLength(1);
        expect(unbilled[0]!.classifierCostMicro).toBe(classifierCost);
      }
    });
  }
});

describe("groq on motebit-cloud", () => {
  it("is refused before any provider call (no metered Groq stream exists)", async () => {
    cell = { prefix: OPENAI_SHAPED_PREFIXES[0]!, ending: "clean" };
    const { mid, token } = await fundedIdentityToken();
    const res = await POST(
      new Request("http://proxy.test/v1/messages", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "x-proxy-token": token },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(providerRequest).toBeNull();
    expect(fees(mid)).toHaveLength(0);
  });
});
