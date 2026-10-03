/**
 * Proxy model authority + tiered pricing, end to end through a REAL relay and
 * the REAL proxy `POST` (only the providers are faked).
 *
 * Evidence this exists for (cold review, 2026-10-02):
 *
 *   1. `model: "auto"` resolved through the classifier + routing policy to a
 *      concrete model WITHOUT the token's model allowlist: a welcome-credit
 *      token (whose ceiling excludes `gemini-2.5-pro`) reached it via
 *      `research → gemini-2.5-pro`. The resolved model must pass the same
 *      allowlist as an explicitly named one — auto never escalates.
 *   2. `gemini-2.5-pro` was priced at its ≤200k-prompt rate for every size.
 *      Google bills the WHOLE turn at $2.50/$15 per M once the prompt exceeds
 *      200k tokens: 300k prompt + 1k output billed 462,126 micro against a
 *      765,000 micro provider cost before margin.
 *   3. A model whose context-length tiers are not confirmed is refused above
 *      its lowest tier BEFORE anything spends, never billed at a guessed rate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../../services/relay/src/index.js";
import { AUTH_HEADER, createTestRelay } from "../../services/relay/src/__tests__/test-helpers.js";
import { creditAccount } from "../../services/relay/src/accounts.js";
import { POST } from "../../services/proxy/src/app/v1/messages/route.js";
import { calculateCostMicro, CLASSIFIER_MODEL } from "../../services/proxy/src/validation.js";
import {
  memorySpendStore,
  setSpendStoreForTests,
} from "../../services/proxy/src/spend-controls.js";

const ORIGIN = "http://localhost:3000";
const RELAY_URL = "http://relay.internal.test";
const SECRET = "proxy-relay-shared-secret-test";
const SHAPES = ["quick", "chat", "reasoning", "code", "research", "creative", "math"] as const;

let relay: SyncRelay;
let classifierReply: string;
/** Every non-classifier provider call: the model the turn was sent to. */
let turnModels: string[];
let classifierCalls: number;
/** Usage the faked OpenAI-shaped providers report. */
let openaiUsage: { prompt_tokens: number; completion_tokens: number };

function anthropicStream(): Response {
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  return sseResponse(sse);
}

function openaiStream(): Response {
  const u = openaiUsage;
  const sse = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { ...u, total_tokens: u.prompt_tokens + u.completion_tokens } })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  return sseResponse(sse);
}

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
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

async function mintToken(motebitId: string): Promise<{ token: string; models: string[] }> {
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/proxy-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
  });
  expect(res.status).toBe(200);
  const token = ((await res.json()) as { token: string }).token;
  const payloadB64 = token.slice(0, token.indexOf(".")).replace(/-/g, "+").replace(/_/g, "/");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as {
    models: string[];
  };
  return { token, models: payload.models };
}

/** A welcome-credit-only identity (the free tier's model ceiling). */
async function freeCreditToken(): Promise<{ token: string; models: string[]; mid: string }> {
  const mid = await createIdentity();
  process.env.MOTEBIT_FREE_CREDIT_USD = "5";
  return { ...(await mintToken(mid)), mid };
}

/** A deposit-funded identity (the full model ceiling). */
async function depositToken(): Promise<{ token: string; models: string[]; mid: string }> {
  const mid = await createIdentity();
  creditAccount(relay.moteDb.db, mid, 10_000_000, "deposit", `dep-${mid}`, "test deposit");
  return { ...(await mintToken(mid)), mid };
}

function fees(motebitId: string): number[] {
  return (
    relay.moteDb.db
      .prepare("SELECT amount FROM relay_transactions WHERE motebit_id = ? AND type = 'fee'")
      .all(motebitId) as Array<{ amount: number }>
  ).map((r) => -r.amount);
}

function turn(token: string, body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://proxy.test/v1/messages", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-proxy-token": token },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], ...body }),
    }),
  );
}

const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY", "GROQ_API_KEY"];

function configureAllProviders(): void {
  for (const k of PROVIDER_KEYS) process.env[k] = `${k.toLowerCase()}-test-never-real`;
}

beforeEach(async () => {
  process.env.RELAY_PROXY_SECRET = SECRET;
  relay = await createTestRelay();
  process.env.RELAY_PUBLIC_KEY = relay.relayIdentity.publicKeyHex;
  process.env.RELAY_API_URL = RELAY_URL;
  configureAllProviders();
  setSpendStoreForTests(memorySpendStore());
  classifierReply = "chat";
  classifierCalls = 0;
  turnModels = [];
  openaiUsage = { prompt_tokens: 10, completion_tokens: 5 };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(RELAY_URL)) return relay.app.request(url.slice(RELAY_URL.length), init);
    const sent = JSON.parse((init?.body as string | undefined) ?? "{}") as { model?: string };
    if (url.startsWith("https://api.anthropic.com")) {
      if (sent.model === CLASSIFIER_MODEL && turnModels.length === 0 && classifierCalls === 0) {
        classifierCalls++;
        return new Response(
          JSON.stringify({
            content: [{ text: classifierReply }],
            usage: { input_tokens: 100, output_tokens: 1 },
          }),
          { status: 200 },
        );
      }
      turnModels.push(String(sent.model));
      return anthropicStream();
    }
    if (
      url.startsWith("https://api.openai.com") ||
      url.startsWith("https://generativelanguage.googleapis.com") ||
      url.startsWith("https://api.groq.com")
    ) {
      turnModels.push(String(sent.model));
      return openaiStream();
    }
    return realFetch(input, init);
  });
});

afterEach(async () => {
  setSpendStoreForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of [
    ...PROVIDER_KEYS,
    "RELAY_PROXY_SECRET",
    "RELAY_PUBLIC_KEY",
    "RELAY_API_URL",
    "MOTEBIT_FREE_CREDIT_USD",
  ]) {
    delete process.env[k];
  }
  await relay.close();
});

describe("model: auto never escalates past the token's model allowlist", () => {
  it("the welcome-credit ceiling excludes the frontier models (the premise)", async () => {
    const { models } = await freeCreditToken();
    expect(models).not.toContain("gemini-2.5-pro");
    expect(models).not.toContain("claude-opus-4-6");
    expect(models).not.toContain("gpt-5.4");
  });

  for (const shape of SHAPES) {
    it(`free-credit token, auto → ${shape}: the served model is on the token's allowlist`, async () => {
      const { token, models } = await freeCreditToken();
      classifierReply = shape;
      const res = await turn(token, { model: "auto" });
      expect(res.status).toBe(200);
      await res.text();
      expect(turnModels).toHaveLength(1);
      expect(models).toContain(turnModels[0]);
    });

    it(`free-credit token, auto → ${shape}, only Anthropic configured: the default is still allowlisted`, async () => {
      for (const k of PROVIDER_KEYS) if (k !== "ANTHROPIC_API_KEY") delete process.env[k];
      const { token, models } = await freeCreditToken();
      classifierReply = shape;
      const res = await turn(token, { model: "auto" });
      expect(res.status).toBe(200);
      await res.text();
      expect(turnModels).toHaveLength(1);
      expect(models).toContain(turnModels[0]);
    });
  }

  it("deposit token, auto → research still reaches the policy's model (no regression)", async () => {
    const { token } = await depositToken();
    classifierReply = "research";
    const res = await turn(token, { model: "auto" });
    expect(res.status).toBe(200);
    await res.text();
    expect(turnModels).toEqual(["gemini-2.5-pro"]);
  });

  it("an explicitly named model outside the allowlist is still refused before spend", async () => {
    const { token } = await freeCreditToken();
    const res = await turn(token, { model: "gemini-2.5-pro" });
    expect(res.status).toBe(400);
    expect(turnModels).toHaveLength(0);
  });
});

describe("gemini-2.5-pro is billed at Google's tier for the REPORTED prompt size", () => {
  const cases = [
    { prompt: 200_000, output: 1_000, input: 1.25, out: 10 },
    { prompt: 200_001, output: 1_000, input: 2.5, out: 15 },
    { prompt: 300_000, output: 1_000, input: 2.5, out: 15 },
  ];
  for (const c of cases) {
    it(`${c.prompt} prompt tokens → the whole turn at $${c.input}/$${c.out} per M (+20%)`, async () => {
      const { token, mid } = await depositToken();
      openaiUsage = { prompt_tokens: c.prompt, completion_tokens: c.output };
      const res = await turn(token, { model: "gemini-2.5-pro" });
      expect(res.status).toBe(200);
      await res.text();
      const providerCost = (c.prompt * c.input + c.output * c.out) / 1_000_000;
      const expected = Math.ceil(providerCost * 1.2 * 1_000_000);
      expect(fees(mid)).toEqual([expected]);
      // Never below what Google billed.
      expect(expected).toBeGreaterThanOrEqual(Math.round(providerCost * 1_000_000));
    });
  }

  it("the reviewer's probe: 300k + 1k is not billed below the 765,000 micro provider cost", async () => {
    const { token, mid } = await depositToken();
    openaiUsage = { prompt_tokens: 300_000, completion_tokens: 1_000 };
    const res = await turn(token, { model: "gemini-2.5-pro" });
    await res.text();
    expect(fees(mid)[0]).toBeGreaterThanOrEqual(765_000);
    expect(fees(mid)[0]).toBe(calculateCostMicro("gemini-2.5-pro", 300_000, 1_000));
  });
});

describe("a prompt above a model's confirmed-pricing ceiling is refused before spend", () => {
  // ~270KB of text: the conservative byte bound exceeds a 200k-token ceiling.
  const BIG = [
    { role: "user", content: "a".repeat(90_000) },
    { role: "assistant", content: "b".repeat(90_000) },
    { role: "user", content: "c".repeat(90_000) },
  ];

  it("gpt-5.4 (tiers unconfirmed) with a prompt that could exceed 200k tokens → 400, provider never called", async () => {
    const { token, mid } = await depositToken();
    const res = await turn(token, { model: "gpt-5.4", messages: BIG });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("prompt_exceeds_priced_tier");
    expect(turnModels).toHaveLength(0);
    expect(fees(mid)).toEqual([]);
  });

  it("auto → code with the same prompt routes to a model whose pricing covers it, never gpt-5.4", async () => {
    const { token } = await depositToken();
    classifierReply = "code";
    const res = await turn(token, { model: "auto", messages: BIG });
    expect(res.status).toBe(200);
    await res.text();
    expect(turnModels).toHaveLength(1);
    expect(turnModels[0]).not.toBe("gpt-5.4");
  });

  it("gemini-2.5-pro (tiers confirmed) serves the same prompt and prices it by tier", async () => {
    const { token } = await depositToken();
    const res = await turn(token, { model: "gemini-2.5-pro", messages: BIG });
    expect(res.status).toBe(200);
    await res.text();
    expect(turnModels).toEqual(["gemini-2.5-pro"]);
  });
});
