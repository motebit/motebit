/**
 * `model: "auto"` resolves to a model the token is allowed to name — the same
 * allowlist an explicit model passes — on every routing exit (route, fallback,
 * deny, no provider key, no classifier key). Auto never escalates.
 *
 * Cross-service sibling (real relay-minted welcome-credit token):
 * `scripts/__tests__/proxy-model-pricing-authority.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as validation from "../validation";
import type { ProxyTokenPayload } from "../validation";

vi.mock("../validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../validation")>();
  return { ...actual, parseProxyToken: vi.fn() };
});

import { POST } from "../app/v1/messages/route";
import { setSpendStoreForTests, memorySpendStore } from "../spend-controls";

const SHAPES = ["quick", "chat", "reasoning", "code", "research", "creative", "math"];
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY", "GROQ_API_KEY"];

let classifierReply: string;
let served: string[];

function sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(enc.encode(s));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function token(models: string[], bal = 5_000_000): void {
  vi.mocked(validation.parseProxyToken).mockResolvedValue({
    mid: "mote-1",
    jti: `jti-${Math.random()}`,
    bal,
    models,
    iat: Date.now(),
    exp: Date.now() + 3_600_000,
  } as ProxyTokenPayload);
}

function auto(): Promise<Response> {
  return POST(
    new Request("https://proxy.example/api/v1/messages", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "x-proxy-token": "tok",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    }),
  );
}

beforeEach(() => {
  process.env.RELAY_PUBLIC_KEY = "test-pubkey";
  process.env.RELAY_API_URL = "https://relay.test";
  process.env.RELAY_PROXY_SECRET = "test-relay-proxy-secret";
  for (const k of KEYS) process.env[k] = `${k}-test`;
  setSpendStoreForTests(memorySpendStore());
  classifierReply = "chat";
  served = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let classified = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/debit")) {
        return new Response(JSON.stringify({ success: true, balance: 1 }), { status: 200 });
      }
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as { model?: string };
      if (!classified && body.model === validation.CLASSIFIER_MODEL) {
        classified = true;
        return new Response(
          JSON.stringify({
            content: [{ text: classifierReply }],
            usage: { input_tokens: 9, output_tokens: 1 },
          }),
          { status: 200 },
        );
      }
      served.push(String(body.model));
      if (String(url).startsWith("https://api.anthropic.com")) {
        return sse([
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2 } })}\n\n`,
        ]);
      }
      return sse([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }),
  );
});

afterEach(() => {
  setSpendStoreForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of [...KEYS, "RELAY_API_URL", "RELAY_PROXY_SECRET"]) delete process.env[k];
});

describe("auto resolves inside the token's allowlist", () => {
  // A ceiling that excludes AUTO_DEFAULT_MODEL itself: the deny / no-key exits
  // used to substitute the default without asking the allowlist.
  const NARROW = ["claude-haiku-4-5-20251001"];
  it("the premise: the narrow ceiling excludes the auto default", () => {
    expect(NARROW).not.toContain(validation.AUTO_DEFAULT_MODEL);
  });

  for (const shape of SHAPES) {
    it(`${shape}: all providers configured → served model is allowlisted`, async () => {
      token(NARROW);
      classifierReply = shape;
      const res = await auto();
      expect(res.status).toBe(200);
      await res.text();
      expect(served).toEqual(NARROW);
    });

    it(`${shape}: only Anthropic configured → served model is allowlisted`, async () => {
      for (const k of KEYS) if (k !== "ANTHROPIC_API_KEY") delete process.env[k];
      token(NARROW);
      classifierReply = shape;
      const res = await auto();
      expect(res.status).toBe(200);
      await res.text();
      expect(served).toEqual(NARROW);
    });

    it(`${shape}: a Google-only ceiling with no Google key is refused, never escalated`, async () => {
      delete process.env.GOOGLE_AI_API_KEY;
      token(["gemini-2.5-flash"]);
      classifierReply = shape;
      const res = await auto();
      expect(res.status).not.toBe(200);
      expect(served).toEqual([]);
    });
  }

  it("no classifier key → the default only if allowlisted, else an allowed model", async () => {
    for (const k of KEYS) if (k !== "ANTHROPIC_API_KEY") delete process.env[k];
    token(NARROW);
    // Classifier unreachable (non-2xx) is the same exit as no classifier key for routing.
    classifierReply = "not-a-shape";
    const res = await auto();
    expect(res.status).toBe(200);
    await res.text();
    expect(served).toEqual(NARROW);
  });
});
