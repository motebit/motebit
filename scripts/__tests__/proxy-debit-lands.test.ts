/**
 * Proxy → relay debit, end to end: a served motebit-cloud turn MUST leave a
 * `fee` row in the relay ledger, or a structured failure the operator can count.
 *
 * Evidence this exists for (2026-10-02): the operator's provider key spent
 * $410 over three months while the production relay recorded ZERO `fee` rows,
 * ever. Every case here boots a REAL relay (`createTestRelay` — the relay's
 * own auth stack: master-token catch-all, agent-route middleware, the
 * in-handler `x-relay-secret` check), funds the identity
 * through the production welcome-credit path (`MOTEBIT_FREE_CREDIT_USD`,
 * granted at mint), mints a REAL proxy token from the relay's `/proxy-token`
 * route, and drives the REAL proxy `POST` handler. Only the provider is faked;
 * the proxy's `fetch` to `RELAY_API_URL` is routed into the relay app
 * in-process. Lives here (beside the other cross-service conformance tests)
 * so neither service takes a workspace dependency on the other.
 *
 * Invariants:
 *   1. The fee lands BEFORE the client's stream ends. Work after the response
 *      completes is not guaranteed to run on the edge runtime, so a debit
 *      scheduled after `writer.close()` is a debit the platform may drop.
 *   2. A client that disconnects mid-stream is still billed.
 *   3. Billing that cannot land (no secret, no relay URL, no deployed spend
 *      store) refuses motebit-cloud at admission — never serves unbilled.
 *   4. A debit larger than the spendable balance drains the balance (and says
 *      so) instead of recording nothing, so the next token is refused.
 *   5. Every debit attempt ends in exactly one structured event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../../services/relay/src/index.js";
import { AUTH_HEADER, createTestRelay } from "../../services/relay/src/__tests__/test-helpers.js";
import { POST } from "../../services/proxy/src/app/v1/messages/route.js";
import { calculateCostMicro } from "../../services/proxy/src/validation.js";
import {
  memorySpendStore,
  setSpendStoreForTests,
} from "../../services/proxy/src/spend-controls.js";

const ORIGIN = "http://localhost:3000";
const RELAY_URL = "http://relay.internal.test";
const SECRET = "proxy-relay-shared-secret-test";
const MODEL = "claude-sonnet-4-6";
const INPUT = 1000;
const OUTPUT = 500;

const SSE = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: INPUT, output_tokens: 1 } } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: OUTPUT } })}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];

let relay: SyncRelay;
let providerCalls: number;
let relayDebitCalls: number;
/** The relay's own RELAY_PROXY_SECRET; the proxy and relay share process.env here. */
let relaySecret: string;
let errors: string[];
let logs: string[];

/** The SSE the faked provider answers 200 with — the happy stream unless a case swaps it. */
let providerSse: string[];

function providerStream(): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of providerSse) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function createIdentity(): Promise<string> {
  const res = await relay.app.request("/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  return ((await res.json()) as { motebit_id: string }).motebit_id;
}

/** Fund the next mint through the production welcome-credit grant. */
function fund(usd: number): void {
  process.env.MOTEBIT_FREE_CREDIT_USD = String(usd);
}

async function mintToken(motebitId: string): Promise<string> {
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function fees(motebitId: string): Array<{ amount: number; reference_id: string | null }> {
  return relay.moteDb.db
    .prepare(
      "SELECT amount, reference_id FROM relay_transactions WHERE motebit_id = ? AND type = 'fee'",
    )
    .all(motebitId) as Array<{ amount: number; reference_id: string | null }>;
}

function balance(motebitId: string): number {
  const row = relay.moteDb.db
    .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
    .get(motebitId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}

function turn(token: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return POST(
    new Request("http://proxy.test/v1/messages", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-proxy-token": token },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
        ...extra,
      }),
    }),
  );
}

function events(name: string, stream: string[] = errors.concat(logs)): Record<string, unknown>[] {
  return stream
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e != null && e.event === name);
}

async function until(pred: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

const EXPECTED_COST = calculateCostMicro(MODEL, INPUT, OUTPUT, 0, 0);

beforeEach(async () => {
  process.env.RELAY_PROXY_SECRET = SECRET;
  relay = await createTestRelay();
  process.env.RELAY_PUBLIC_KEY = relay.relayIdentity.publicKeyHex;
  process.env.RELAY_API_URL = RELAY_URL;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-real";
  setSpendStoreForTests(memorySpendStore());
  providerSse = SSE;
  providerCalls = 0;
  relayDebitCalls = 0;
  relaySecret = SECRET;
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((s: unknown) => void errors.push(String(s)));
  vi.spyOn(console, "log").mockImplementation((s: unknown) => void logs.push(String(s)));
  vi.spyOn(console, "warn").mockImplementation((s: unknown) => void logs.push(String(s)));
  vi.spyOn(console, "info").mockImplementation(() => {});
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(RELAY_URL)) {
      relayDebitCalls++;
      // Run the relay under ITS secret (the proxy already read its own).
      const proxyView = process.env.RELAY_PROXY_SECRET;
      process.env.RELAY_PROXY_SECRET = relaySecret;
      try {
        return await relay.app.request(url.slice(RELAY_URL.length), init);
      } finally {
        if (proxyView === undefined) delete process.env.RELAY_PROXY_SECRET;
        else process.env.RELAY_PROXY_SECRET = proxyView;
      }
    }
    if (url.startsWith("https://api.anthropic.com")) {
      providerCalls++;
      return providerStream();
    }
    return realFetch(input, init);
  });
});

afterEach(async () => {
  setSpendStoreForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of [
    "RELAY_PROXY_SECRET",
    "RELAY_PUBLIC_KEY",
    "RELAY_API_URL",
    "ANTHROPIC_API_KEY",
    "VERCEL_ENV",
    "MOTEBIT_FREE_CREDIT_USD",
  ]) {
    delete process.env[k];
  }
  await relay.close();
});

describe("proxy debit lands in the relay ledger (production auth config)", () => {
  it("a served turn records a `fee` of the metered cost, keyed by the request id, before the stream ends", async () => {
    const mid = await createIdentity();
    fund(5);

    const res = await turn(await mintToken(mid));
    expect(res.status).toBe(200);
    await res.text(); // client reads to EOF

    // At EOF — not "eventually": nothing after the response is guaranteed to run.
    const rows = fees(mid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(-EXPECTED_COST);
    expect(rows[0]!.reference_id).toBe(res.headers.get("X-Motebit-Request-Id"));
    expect(balance(mid)).toBe(5_000_000 - EXPECTED_COST);
    expect(events("proxy.debit_landed")).toHaveLength(1);
    expect(events("proxy.debit_failed")).toHaveLength(0);
  });

  it("a client that disconnects mid-stream is still billed", async () => {
    const mid = await createIdentity();
    fund(5);

    const res = await turn(await mintToken(mid));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    // Billed for what was metered before the disconnect (the upstream is
    // cancelled, so the final output count never arrives) — never zero.
    expect(await until(() => fees(mid).length === 1)).toBe(true);
    const metered = events("proxy.usage")[0]!.costMicro as number;
    expect(metered).toBeGreaterThan(0);
    expect(fees(mid)[0]!.amount).toBe(-metered);
  });

  it("refuses motebit-cloud (503, zero provider calls) when RELAY_PROXY_SECRET is unset at the proxy", async () => {
    const mid = await createIdentity();
    fund(5);
    const token = await mintToken(mid);
    delete process.env.RELAY_PROXY_SECRET;

    const res = await turn(token);
    expect(res.status).toBe(503);
    expect(providerCalls).toBe(0);
    expect(events("proxy.billing_unconfigured")).toHaveLength(1);
    expect(JSON.stringify(events("proxy.billing_unconfigured"))).not.toContain(SECRET);
  });

  it("refuses motebit-cloud when RELAY_API_URL is unset (no silent default)", async () => {
    const mid = await createIdentity();
    fund(5);
    const token = await mintToken(mid);
    delete process.env.RELAY_API_URL;

    const res = await turn(token);
    expect(res.status).toBe(503);
    expect(providerCalls).toBe(0);
    expect(relayDebitCalls).toBe(0);
  });

  it("refuses motebit-cloud on a deployed environment with no spend store (no per-isolate fallback)", async () => {
    const mid = await createIdentity();
    fund(5);
    const token = await mintToken(mid);
    setSpendStoreForTests(undefined);
    delete process.env.KV_REST_API_URL;
    process.env.VERCEL_ENV = "production";

    const res = await turn(token);
    expect(res.status).toBe(503);
    expect(providerCalls).toBe(0);
  });

  it("a secret mismatch is a counted failure (proxy.debit_failed unauthorized/401), never a silent drop", async () => {
    const mid = await createIdentity();
    fund(5);
    const token = await mintToken(mid);
    process.env.RELAY_PROXY_SECRET = "not-the-relay-secret";

    const res = await turn(token);
    await res.text();
    expect(fees(mid)).toHaveLength(0);
    const failed = events("proxy.debit_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBe("unauthorized");
    expect(failed[0]!.status).toBe(401);
    expect(JSON.stringify(failed)).not.toContain("not-the-relay-secret");
  });

  it("a debit above the spendable balance drains it (fee lands, shortfall reported) so the next token is refused", async () => {
    const mid = await createIdentity();
    fund(0.001); // 1_000 micro — below one turn's cost
    expect(EXPECTED_COST).toBeGreaterThan(1_000);

    const res = await turn(await mintToken(mid));
    await res.text();

    const rows = fees(mid);
    expect(rows[0]!.amount).toBe(-1_000);
    expect(balance(mid)).toBe(0);
    const shortfall = events("proxy.debit_landed");
    expect(shortfall).toHaveLength(1);
    expect(shortfall[0]!.shortfallMicro).toBe(EXPECTED_COST - 1_000);

    // The balance the next token carries is the post-debit one: refused.
    const next = await turn(await mintToken(mid));
    expect(next.status).toBe(402);
  });

  it("a 200 stream carrying only a provider error event (no message_start) is not billed for the provider", async () => {
    const mid = await createIdentity();
    fund(5);
    providerSse = [
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
    ];

    const res = await turn(await mintToken(mid));
    expect(res.status).toBe(200);
    await res.text();

    // The provider never started a message, so it billed nothing — neither does the proxy.
    expect(fees(mid)).toHaveLength(0);
    expect(balance(mid)).toBe(5_000_000);
    const unbilled = events("proxy.turn_unbilled_provider_error");
    expect(unbilled).toHaveLength(1);
    expect(unbilled[0]!.providerErrorType).toBe("overloaded_error");
    expect(unbilled[0]!.requestId).toBe(res.headers.get("X-Motebit-Request-Id"));
  });

  it("an empty 200 body is not billed for the provider", async () => {
    const mid = await createIdentity();
    fund(5);
    providerSse = [];

    const res = await turn(await mintToken(mid));
    expect(res.status).toBe(200);
    await res.text();

    expect(fees(mid)).toHaveLength(0);
    expect(balance(mid)).toBe(5_000_000);
    const unbilled = events("proxy.turn_unbilled_provider_error");
    expect(unbilled).toHaveLength(1);
    expect(unbilled[0]!.providerErrorType).toBe("empty_body");
  });

  it("a stream that started (message_start) and then lost usage is still billed the upper bound", async () => {
    const mid = await createIdentity();
    fund(5);
    providerSse = [SSE[0]!, SSE[1]!];

    const res = await turn(await mintToken(mid));
    await res.text();

    const rows = fees(mid);
    expect(rows).toHaveLength(1);
    expect(-rows[0]!.amount).toBeGreaterThan(EXPECTED_COST);
    expect(events("proxy.turn_unbilled_provider_error")).toHaveLength(0);
    expect(events("proxy.usage")[0]!.estimated).toBe(true);
  });

  it("refuses a server tool (web_search) with 400 unsupported_feature before the provider is called", async () => {
    const mid = await createIdentity();
    fund(5);

    const res = await turn(await mintToken(mid), {
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; feature: string };
    expect(body.error).toBe("unsupported_feature");
    expect(body.feature).toContain("web_search_20250305");
    expect(providerCalls).toBe(0);
    expect(fees(mid)).toHaveLength(0);
    expect(balance(mid)).toBe(5_000_000);
  });

  it("refuses an unknown top-level request feature (mcp_servers) before the provider is called", async () => {
    const mid = await createIdentity();
    fund(5);

    const res = await turn(await mintToken(mid), {
      mcp_servers: [{ type: "url", url: "https://mcp.example", name: "x" }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { feature: string }).feature).toContain("mcp_servers");
    expect(providerCalls).toBe(0);
    expect(fees(mid)).toHaveLength(0);
  });
});
