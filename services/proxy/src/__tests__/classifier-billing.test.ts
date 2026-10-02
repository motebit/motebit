/**
 * Classifier spend is billed exactly once on EVERY exit — or never spent.
 *
 * `model: "auto"` on the motebit-cloud path calls Anthropic once (the routing
 * classifier) on the operator's key before the turn is served. Two rules:
 *
 *   1. A request whose shape is invalid (no messages, too many messages) is
 *      refused BEFORE the classifier runs, so it never spends.
 *   2. Every return after the classifier has spent discharges the classifier
 *      obligation exactly once: either a classifier-only debit (failure exits)
 *      or folded into the streamed turn's debit (success). Each exit below is
 *      forced and asserts one debit attempt + one debit event.
 *
 * Review evidence (2026-10-02): `auto` + 201 messages / `messages: []` called
 * the classifier, then returned 400 with no fee row and no debit event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as validation from "../validation";
import type { ProxyTokenPayload } from "../validation";

vi.mock("../validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../validation")>();
  return {
    ...actual,
    parseProxyToken: vi.fn(),
    getModelProvider: vi.fn(actual.getModelProvider),
    isModelAllowedInMotebitCloud: vi.fn(actual.isModelAllowedInMotebitCloud),
  };
});

import { POST } from "../app/v1/messages/route";
import { setSpendStoreForTests, memorySpendStore } from "../spend-controls";

const ORIGIN = "http://localhost:3000";
const PROXY = { origin: ORIGIN, "x-proxy-token": "tok", "content-type": "application/json" };
const CLASSIFIER_COST = validation.calculateCostMicro(validation.CLASSIFIER_MODEL, 200, 20);

let lines: string[];
let store: ReturnType<typeof memorySpendStore>;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../validation")>("../validation");
  vi.mocked(validation.getModelProvider).mockImplementation(actual.getModelProvider);
  vi.mocked(validation.isModelAllowedInMotebitCloud).mockImplementation(
    actual.isModelAllowedInMotebitCloud,
  );
  vi.mocked(validation.parseProxyToken).mockResolvedValue({
    mid: "mote-1",
    jti: "jti-1",
    bal: 1_000_000,
    models: [],
    iat: Date.now(),
    exp: Date.now() + 3_600_000,
  } as ProxyTokenPayload);
  process.env.RELAY_PUBLIC_KEY = "test-pubkey";
  process.env.RELAY_API_URL = "https://relay.test";
  process.env.RELAY_PROXY_SECRET = "test-relay-proxy-secret";
  process.env.ANTHROPIC_API_KEY = "sk-server-test";
  store = memorySpendStore();
  setSpendStoreForTests(store);
  lines = [];
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
});
afterEach(() => {
  setSpendStoreForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.RELAY_API_URL;
  delete process.env.RELAY_PROXY_SECRET;
  delete process.env.ANTHROPIC_API_KEY;
});

type Upstream = Response | Error | "never";

/**
 * Stub fetch: the classifier call (body.model === CLASSIFIER_MODEL) answers
 * "chat"; the relay debit answers success; the turn's provider call answers
 * `upstream`. Records each kind.
 */
function stubFetch(upstream: Upstream) {
  const calls = { classifier: 0, provider: 0, debits: [] as number[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/debit")) {
        calls.debits.push((JSON.parse(init?.body as string) as { amount: number }).amount);
        return new Response(JSON.stringify({ success: true, balance: 1 }), { status: 200 });
      }
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as { model?: string };
      if (body.model === validation.CLASSIFIER_MODEL) {
        calls.classifier++;
        return new Response(JSON.stringify({ content: [{ text: "chat" }] }), { status: 200 });
      }
      calls.provider++;
      if (upstream === "never") throw new Error("provider must not be called on this exit");
      if (upstream instanceof Error) throw upstream;
      return upstream;
    }),
  );
  return calls;
}

function debitEvents(): Array<Record<string, unknown>> {
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (e): e is Record<string, unknown> =>
        e?.event === "proxy.debit_landed" || e?.event === "proxy.debit_failed",
    );
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("https://proxy.example/api/v1/messages", {
      method: "POST",
      headers: PROXY,
      body: JSON.stringify(body),
    }),
  );
}

const ONE = [{ role: "user", content: "hi" }];

describe("invalid request shape is refused before the classifier spends", () => {
  const cases: Array<{ name: string; messages: unknown }> = [
    { name: "messages: []", messages: [] },
    { name: "messages missing", messages: undefined },
    { name: "messages not an array", messages: "hi" },
    {
      name: "201 messages (over DEPOSIT_LIMITS.maxMsgs)",
      messages: Array.from({ length: validation.DEPOSIT_LIMITS.maxMsgs + 1 }, () => ONE[0]),
    },
  ];
  for (const c of cases) {
    it(`auto + ${c.name} → 400, zero provider calls, nothing to bill`, async () => {
      const calls = stubFetch("never");
      const res = await post({ model: "auto", messages: c.messages });
      expect(res.status).toBe(400);
      expect(calls.classifier).toBe(0);
      expect(calls.provider).toBe(0);
      expect(calls.debits).toEqual([]);
      expect(store.map.get("proxy:active:mote-1")).toBe(0);
    });
  }
});

describe("every exit after the classifier bills it exactly once", () => {
  function sse(): Response {
    const enc = new TextEncoder();
    const ev = [
      { type: "message_start", message: { usage: { input_tokens: 100 } } },
      { type: "message_delta", usage: { output_tokens: 50 } },
    ];
    return new Response(
      new ReadableStream({
        start(c) {
          for (const e of ev) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  const exits: Array<{
    name: string;
    status: number;
    setup?: () => void;
    upstream: Upstream;
    expectedDebit: () => number;
  }> = [
    {
      name: "451 jurisdiction_not_permitted",
      status: 451,
      setup: () => vi.mocked(validation.isModelAllowedInMotebitCloud).mockReturnValue(false),
      upstream: "never",
      expectedDebit: () => CLASSIFIER_COST,
    },
    {
      name: "400 model not supported (no provider)",
      status: 400,
      setup: () => vi.mocked(validation.getModelProvider).mockReturnValue(null),
      upstream: "never",
      expectedDebit: () => CLASSIFIER_COST,
    },
    {
      name: "501 provider_not_configured",
      status: 501,
      setup: () => vi.mocked(validation.getModelProvider).mockReturnValue("openai"),
      upstream: "never",
      expectedDebit: () => CLASSIFIER_COST,
    },
    {
      name: "502 provider transport failure",
      status: 502,
      upstream: new TypeError("network down"),
      expectedDebit: () => CLASSIFIER_COST,
    },
    {
      name: "provider non-2xx pass-through",
      status: 529,
      upstream: new Response(JSON.stringify({ error: { type: "overloaded_error" } }), {
        status: 529,
      }),
      expectedDebit: () => CLASSIFIER_COST,
    },
    {
      name: "2xx with no body (non-streaming pipe)",
      status: 200,
      upstream: new Response(null, { status: 200 }),
      expectedDebit: () => CLASSIFIER_COST,
    },
    {
      name: "streamed success (classifier folded into the turn's debit, not billed twice)",
      status: 200,
      upstream: sse(),
      expectedDebit: () =>
        validation.calculateCostMicro(validation.AUTO_DEFAULT_MODEL, 100, 50, 0, 0) +
        CLASSIFIER_COST,
    },
  ];

  for (const x of exits) {
    it(x.name, async () => {
      x.setup?.();
      const calls = stubFetch(x.upstream);
      const res = await post({ model: "auto", messages: ONE });
      expect(res.status).toBe(x.status);
      await res.text().catch(() => "");
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.classifier).toBe(1);
      expect(calls.debits).toEqual([x.expectedDebit()]);
      expect(debitEvents()).toHaveLength(1);
      expect(store.map.get("proxy:active:mote-1")).toBe(0);
    });
  }

  it("a concrete model never runs the classifier, so a failure exit bills nothing", async () => {
    const calls = stubFetch(new TypeError("network down"));
    const res = await post({ model: "claude-sonnet-4-6", messages: ONE });
    expect(res.status).toBe(502);
    expect(calls.classifier).toBe(0);
    expect(calls.debits).toEqual([]);
  });
});

describe("structural guard — no exit after the classifier bypasses the obligation", () => {
  // Every `return` after the classifier block must go through `settled(...)`
  // (which discharges the classifier debit) or be the streamed response whose
  // pump folds `classifierCost` into the turn's debit. A new bare
  // `released(...)` / `return failureResponse` / `return new Response` added
  // below the classifier would skip the bill — this fails it.
  it("route.ts: returns after the classifier all discharge through settled()", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../app/v1/messages/route.ts", import.meta.url)),
      "utf8",
    );
    const start = src.indexOf("const settled = ");
    expect(start).toBeGreaterThan(0);
    const after = src.slice(start);
    expect(after).not.toMatch(/\breleased\(/);
    const returns = after.match(/^\s*return\b.*$/gm) ?? [];
    const allowed = returns.filter(
      (r) =>
        /return settled\(/.test(r) ||
        /return new Response\(readable,/.test(r) ||
        // the wrapper.s own body
        /return r;/.test(r),
    );
    expect(returns.filter((r) => !allowed.includes(r))).toEqual([]);
  });
});
