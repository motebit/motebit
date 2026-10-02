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
    getProviderCatalog: vi.fn(actual.getProviderCatalog),
  };
});
vi.mock("../app/v1/messages/provider-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/v1/messages/provider-request")>();
  return { ...actual, buildProviderRequest: vi.fn(actual.buildProviderRequest) };
});
vi.mock("@motebit/policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/policy")>();
  return { ...actual, dispatchRouting: vi.fn(actual.dispatchRouting) };
});

import * as providerRequest from "../app/v1/messages/provider-request";
import * as policy from "@motebit/policy";
import { POST, CLASSIFIER_INPUT_TOKEN_BOUND } from "../app/v1/messages/route";
import { setSpendStoreForTests, memorySpendStore } from "../spend-controls";

const ORIGIN = "http://localhost:3000";
const PROXY = { origin: ORIGIN, "x-proxy-token": "tok", "content-type": "application/json" };
/** The classifier stub reports this usage — the bill is computed from it. */
const CLASSIFIER_USAGE = { input_tokens: 143, output_tokens: 2 };
const CLASSIFIER_COST = validation.calculateCostMicro(
  validation.CLASSIFIER_MODEL,
  CLASSIFIER_USAGE.input_tokens,
  CLASSIFIER_USAGE.output_tokens,
);

let lines: string[];
let store: ReturnType<typeof memorySpendStore>;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../validation")>("../validation");
  vi.mocked(validation.getModelProvider).mockImplementation(actual.getModelProvider);
  vi.mocked(validation.isModelAllowedInMotebitCloud).mockImplementation(
    actual.isModelAllowedInMotebitCloud,
  );
  vi.mocked(validation.getProviderCatalog).mockImplementation(actual.getProviderCatalog);
  const pr = await vi.importActual<typeof import("../app/v1/messages/provider-request")>(
    "../app/v1/messages/provider-request",
  );
  vi.mocked(providerRequest.buildProviderRequest).mockImplementation(pr.buildProviderRequest);
  const pol = await vi.importActual<typeof import("@motebit/policy")>("@motebit/policy");
  vi.mocked(policy.dispatchRouting).mockImplementation(pol.dispatchRouting);
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
 * `classifier()` (default: 2xx "chat" with CLASSIFIER_USAGE); the relay debit
 * answers success; the turn's provider call answers `upstream`. Records each
 * kind, and the classifier prompt it was sent.
 */
function stubFetch(upstream: Upstream, classifier?: () => Response | Error) {
  const calls = { classifier: 0, provider: 0, debits: [] as number[], prompts: [] as string[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/debit")) {
        calls.debits.push((JSON.parse(init?.body as string) as { amount: number }).amount);
        return new Response(JSON.stringify({ success: true, balance: 1 }), { status: 200 });
      }
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
        model?: string;
        messages?: Array<{ content: string }>;
      };
      if (body.model === validation.CLASSIFIER_MODEL) {
        calls.classifier++;
        calls.prompts.push(body.messages?.[0]?.content ?? "");
        const r = classifier?.();
        if (r instanceof Error) throw r;
        return (
          r ??
          new Response(JSON.stringify({ content: [{ text: "chat" }], usage: CLASSIFIER_USAGE }), {
            status: 200,
          })
        );
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
    // Element shape — a malformed element used to pass the array check, let the
    // classifier spend, then throw (`.slice` on a number, `null.role`) with the
    // spend unbilled or billed without a classifier call.
    { name: "messages: [null]", messages: [null] },
    { name: "last content is a number", messages: [{ role: "user", content: 5 }] },
    { name: "content missing", messages: [{ role: "user" }] },
    { name: "content is an object", messages: [{ role: "user", content: { text: "hi" } }] },
    { name: "unknown role", messages: [{ role: "wizard", content: "hi" }] },
    { name: "role missing", messages: [{ content: "hi" }] },
    { name: "element is a string", messages: ["hi"] },
    { name: "element is an array", messages: [[{ role: "user", content: "hi" }]] },
    {
      name: "a bad element before a good last one",
      messages: [null, { role: "user", content: "hi" }],
    },
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

describe("classifier cost is billed only when the classifier actually spent", () => {
  // Anthropic bills a request that returns 2xx; a request the API rejects (4xx/
  // 5xx) or one that never got a response is not billed. So a classifier
  // non-2xx / transport throw is NOT spent: the turn routes to the default and
  // a later failure exit bills nothing. Review evidence (2026-10-02): a
  // classifier 500 or throw followed by an upstream failure debited 360 micro.
  const notSpent: Array<{ name: string; classifier: () => Response | Error }> = [
    { name: "classifier 500", classifier: () => new Response("{}", { status: 500 }) },
    {
      name: "classifier 400",
      classifier: () => new Response(JSON.stringify({ error: {} }), { status: 400 }),
    },
    { name: "classifier 529", classifier: () => new Response("overloaded", { status: 529 }) },
    { name: "classifier transport throw", classifier: () => new TypeError("fetch failed") },
  ];
  for (const c of notSpent) {
    it(`${c.name} then upstream 502 → zero debits, slot released`, async () => {
      const calls = stubFetch(new TypeError("network down"), c.classifier);
      const res = await post({ model: "auto", messages: ONE });
      expect(res.status).toBe(502);
      expect(calls.classifier).toBe(1);
      expect(calls.debits).toEqual([]);
      expect(debitEvents()).toHaveLength(0);
      expect(store.map.get("proxy:active:mote-1")).toBe(0);
    });
    it(`${c.name} then streamed success → the turn's debit carries no classifier cost`, async () => {
      const enc = new TextEncoder();
      const calls = stubFetch(
        new Response(
          new ReadableStream({
            start(ctl) {
              ctl.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } })}\n\n`,
                ),
              );
              ctl.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
        c.classifier,
      );
      const res = await post({ model: "auto", messages: ONE });
      await res.text();
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.debits).toEqual([
        validation.calculateCostMicro(validation.AUTO_DEFAULT_MODEL, 10, 0, 0, 0),
      ]);
    });
  }

  it("2xx classifier with a usage block → billed from its own usage", async () => {
    const calls = stubFetch(
      new TypeError("network down"),
      () =>
        new Response(
          JSON.stringify({
            content: [{ text: "code" }],
            usage: { input_tokens: 90, output_tokens: 1 },
          }),
          { status: 200 },
        ),
    );
    const res = await post({ model: "auto", messages: ONE });
    expect(res.status).toBe(502);
    expect(calls.debits).toEqual([
      validation.calculateCostMicro(validation.CLASSIFIER_MODEL, 90, 1),
    ]);
  });

  const noUsage: Array<{ name: string; classifier: () => Response }> = [
    {
      name: "no usage block",
      classifier: () =>
        new Response(JSON.stringify({ content: [{ text: "chat" }] }), { status: 200 }),
    },
    {
      name: "malformed usage",
      classifier: () =>
        new Response(
          JSON.stringify({ content: [], usage: { input_tokens: "x", output_tokens: -1 } }),
          {
            status: 200,
          },
        ),
    },
    { name: "non-JSON 2xx body", classifier: () => new Response("not json", { status: 200 }) },
  ];
  for (const c of noUsage) {
    it(`2xx classifier, ${c.name} → billed at the documented upper bound`, async () => {
      const calls = stubFetch(new TypeError("network down"), c.classifier);
      const res = await post({ model: "auto", messages: ONE });
      expect(res.status).toBe(502);
      expect(calls.debits).toEqual([
        validation.calculateCostMicro(
          validation.CLASSIFIER_MODEL,
          CLASSIFIER_INPUT_TOKEN_BOUND,
          30,
        ),
      ]);
      expect(debitEvents()).toHaveLength(1);
      expect(store.map.get("proxy:active:mote-1")).toBe(0);
    });
  }

  it("block-array content is classified on its text, never on `[object Object]`", async () => {
    const calls = stubFetch(new TypeError("network down"));
    await post({
      model: "auto",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "write a sorting function" },
            { type: "image", source: {} },
          ],
        },
      ],
    });
    expect(calls.classifier).toBe(1);
    expect(calls.prompts[0]).toContain("write a sorting function");
    expect(calls.prompts[0]).not.toContain("[object Object]");
  });
});

describe("a throw at any stage after the classifier still settles once", () => {
  // Every stage after the classifier spent is forced to throw. The single
  // settlement obligation must still bill the classifier exactly once, emit
  // one debit event, release the spend slot, and answer a loud 500 — never an
  // unhandled rejection with the spend silently unbilled.
  const boom = () => {
    throw new TypeError("injected");
  };
  const stages: Array<{ name: string; inject: () => void }> = [
    {
      name: "catalog lookup (getProviderCatalog)",
      inject: () => vi.mocked(validation.getProviderCatalog).mockImplementation(boom),
    },
    {
      name: "routing dispatch (dispatchRouting)",
      inject: () => vi.mocked(policy.dispatchRouting).mockImplementation(boom),
    },
    {
      name: "provider resolution (getModelProvider)",
      inject: () => vi.mocked(validation.getModelProvider).mockImplementation(boom),
    },
    {
      name: "jurisdiction check (isModelAllowedInMotebitCloud)",
      inject: () => vi.mocked(validation.isModelAllowedInMotebitCloud).mockImplementation(boom),
    },
    {
      name: "request build (buildProviderRequest)",
      inject: () => vi.mocked(providerRequest.buildProviderRequest).mockImplementation(boom),
    },
  ];
  for (const st of stages) {
    it(st.name, async () => {
      st.inject();
      const calls = stubFetch(new TypeError("network down"));
      const res = await post({ model: "auto", messages: ONE });
      expect(res.status).toBe(500);
      expect(calls.classifier).toBe(1);
      expect(calls.debits).toEqual([CLASSIFIER_COST]);
      expect(debitEvents()).toHaveLength(1);
      expect(store.map.get("proxy:active:mote-1")).toBe(0);
      expect(lines.some((l) => l.includes("proxy.internal_failure"))).toBe(true);
    });
  }

  it("a throw with no classifier spend releases the slot and bills nothing", async () => {
    vi.mocked(providerRequest.buildProviderRequest).mockImplementation(boom);
    const calls = stubFetch("never");
    const res = await post({ model: "claude-sonnet-4-6", messages: ONE });
    expect(res.status).toBe(500);
    expect(calls.debits).toEqual([]);
    expect(store.map.get("proxy:active:mote-1")).toBe(0);
  });
});

describe("structural guard — one settlement obligation, no bypass", () => {
  // POST wraps everything after admission in ONE try/finally that settles the
  // turn (classifier debit if spent + slot release). `serveAdmitted` must never
  // settle on its own; the only other settlement is the streamed pump, which
  // takes the obligation over via `bill.handedOff`. A new exit added inside
  // `serveAdmitted` therefore cannot skip the bill — and a second settlement
  // path added there (a stray release / classifier debit) fails this.
  const src = readFileSync(
    fileURLToPath(new URL("../app/v1/messages/route.ts", import.meta.url)),
    "utf8",
  );
  const serveAt = src.indexOf("async function serveAdmitted(");
  const post = src.slice(src.indexOf("export async function POST("), serveAt);
  const serve = src.slice(serveAt);

  it("POST serves inside one try whose finally settles unless handed off", () => {
    expect(serveAt).toBeGreaterThan(0);
    expect(post.match(/serveAdmitted\(/g)).toHaveLength(1);
    expect(post).toMatch(/try \{\s*return await serveAdmitted\(/);
    expect(post).toMatch(
      /\} finally \{\s*if \(!bill\.handedOff\) \{[\s\S]*debitRelay\([\s\S]*release\(\)/,
    );
  });

  it("serveAdmitted settles only through the hand-off to the streamed pump", () => {
    expect(serve).not.toMatch(/\breleased\(|\bsettled\(/);
    expect(serve.match(/\.release\(\)/g)).toHaveLength(1);
    expect(serve.match(/\bdebitRelay\(/g)).toHaveLength(1);
    expect(serve.match(/bill\.handedOff = true/g)).toHaveLength(1);
    // The pump that owns the release is the one that receives the hand-off.
    const handoff = serve.indexOf("bill.handedOff = true");
    expect(serve.indexOf("void (async () => {")).toBeGreaterThan(handoff);
    expect(serve.indexOf(".release()")).toBeGreaterThan(handoff);
  });

  it("the classifier cost is assigned only from a classifier outcome", () => {
    const assigns = src.match(/bill\.classifierCostMicro = [^;]+;/g) ?? [];
    expect(assigns).toEqual(["bill.classifierCostMicro = classified.costMicro;"]);
  });
});
