/**
 * Invoke Capability tests — surface determinism contract.
 *
 * Asserts the deterministic path:
 *   (a) never invokes `runTurnStreaming` (the AI-loop entry point),
 *   (b) stamps `invocation_origin: "user-tap"` on the relay submission,
 *   (c) yields the documented StreamChunk sequence on success,
 *   (d) maps each DelegationErrorCode onto a single `invoke_error` chunk
 *       without falling through to the AI loop or retrying silently,
 *   (e) stashes the receipt so a concurrent AI loop drains it into its
 *       parent receipt's delegation_receipts chain.
 *
 * Mirrors the mock scaffolding from `interactive-delegation.test.ts` — same
 * runtime, same fetch interception, same test-only ExecutionReceipt builder.
 * Kept in a separate file because the concerns are different: interactive
 * delegation tests assert tool-handler contracts; these tests assert the
 * surface-determinism StreamChunk contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
} from "../index";
import type { PlatformAdapters, StreamChunk } from "../index";
import type { StreamingProvider, AgenticChunk } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ExecutionReceipt } from "@motebit/sdk";

// Intercept runTurnStreaming to assert the deterministic path bypasses it.
const mockRunTurnStreaming = vi.fn();

vi.mock("@motebit/ai-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/ai-core");
  return {
    ...actual,
    runTurnStreaming: (...args: unknown[]) =>
      mockRunTurnStreaming(...args) as AsyncGenerator<AgenticChunk>,
    summarizeConversation: vi.fn().mockResolvedValue("mock summary"),
    shouldSummarize: vi.fn().mockReturnValue(false),
  };
});

const originalFetch = globalThis.fetch;
let mockFetchHandler: (url: string, init?: RequestInit) => Promise<Response>;
let capturedSubmissionBody: Record<string, unknown> | null = null;

function createMockProvider(): StreamingProvider {
  const response: AIResponse = {
    text: "unused",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream() {
      yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

function createAdapters(provider: StreamingProvider): PlatformAdapters {
  return {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: provider,
  };
}

function fakeReceipt(overrides?: Partial<ExecutionReceipt>): ExecutionReceipt {
  return {
    task_id: "relay-task-001",
    motebit_id: "remote-agent-001",
    device_id: "remote-device-001",
    submitted_at: Date.now() - 5000,
    completed_at: Date.now(),
    status: "completed",
    result: "## PR Review\n\nLGTM — no blocking concerns.",
    tools_used: ["review_pr"],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    invocation_origin: "user-tap",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "fake-sig-for-test",
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function enabledRuntime(
  overrides: Partial<{ timeoutMs: number; authToken: (aud?: string) => Promise<string> }> = {},
): MotebitRuntime {
  const rt = new MotebitRuntime(
    { motebitId: "alice-001", tickRateHz: 0 },
    createAdapters(createMockProvider()),
  );
  rt.enableInvokeCapability({
    syncUrl: "https://mock-relay.test",
    authToken: overrides.authToken ?? (async () => "test-token"),
    timeoutMs: overrides.timeoutMs ?? 3000,
  });
  return rt;
}

describe("invokeCapability — surface determinism", () => {
  beforeEach(() => {
    mockRunTurnStreaming.mockReset();
    capturedSubmissionBody = null;
    mockFetchHandler = async () => new Response("not found", { status: 404 });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("mock-relay.test")) return mockFetchHandler(url, init);
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("yields invoke_error{sync_not_enabled} when enableInvokeCapability was not called", async () => {
    const rt = new MotebitRuntime(
      { motebitId: "alice-001", tickRateHz: 0 },
      createAdapters(createMockProvider()),
    );
    const chunks = await collect(rt.invokeCapability("review_pr", "https://example.com"));
    // Must NOT throw — the UI layer maps the chunk to user-facing copy.
    // Throwing would leak developer-wiring language into the chat handler's
    // catch block (historically: "invokeCapability is not enabled — call
    // runtime.enableInvokeCapability(config) first").
    expect(chunks).toHaveLength(1);
    const err = chunks[0];
    expect(err).toBeDefined();
    if (err) {
      expect(err.type).toBe("invoke_error");
      if (err.type === "invoke_error") expect(err.code).toBe("sync_not_enabled");
    }
  });

  // ── Happy path ───────────────────────────────────────────────────────

  it("bypasses the AI loop entirely — runTurnStreaming is never called", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        capturedSubmissionBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ task_id: "t-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ task: { status: "completed" }, receipt: fakeReceipt() }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    await collect(rt.invokeCapability("review_pr", "https://github.com/x/y/pull/1"));
    expect(mockRunTurnStreaming).not.toHaveBeenCalled();
  });

  it("stamps invocation_origin: user-tap by default", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        capturedSubmissionBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ task_id: "t-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ task: { status: "completed" }, receipt: fakeReceipt() }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    await collect(rt.invokeCapability("review_pr", "https://github.com/x/y/pull/1"));
    expect(capturedSubmissionBody?.invocation_origin).toBe("user-tap");
    expect(capturedSubmissionBody?.required_capabilities).toEqual(["review_pr"]);
  });

  it("yields delegation_start → text → delegation_complete on success", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "t-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ task: { status: "completed" }, receipt: fakeReceipt() }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const types = chunks.map((c) => c.type);
    expect(types[0]).toBe("delegation_start");
    expect(types).toContain("text");
    expect(types[types.length - 1]).toBe("delegation_complete");
    // full_receipt on the terminal chunk — the bubble uses this to emerge.
    const final = chunks[chunks.length - 1];
    expect(final).toBeDefined();
    if (final) {
      expect(final.type).toBe("delegation_complete");
      if (final.type === "delegation_complete") {
        expect(final.full_receipt).toBeDefined();
        expect(final.full_receipt?.invocation_origin).toBe("user-tap");
      }
    }
  });

  it("stashes the receipt so a concurrent AI loop can drain it", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "t-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ task: { status: "completed" }, receipt: fakeReceipt() }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    await collect(rt.invokeCapability("review_pr", "url"));
    const stashed = rt.getAndResetInteractiveDelegationReceipts();
    expect(stashed).toHaveLength(1);
    expect(stashed[0]?.invocation_origin).toBe("user-tap");
  });

  // ── Pre-flight failures ─────────────────────────────────────────────

  it("maps 401 → auth_expired", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ code: "AUTH_TOKEN_EXPIRED", error: "token expired" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const err = chunks.find(
      (c): c is Extract<StreamChunk, { type: "invoke_error" }> => c.type === "invoke_error",
    );
    expect(err?.code).toBe("auth_expired");
  });

  it("maps 402 / INSUFFICIENT_FUNDS → insufficient_balance", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ code: "INSUFFICIENT_FUNDS", error: "Insufficient budget" }),
          { status: 402, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const err = chunks.find(
      (c): c is Extract<StreamChunk, { type: "invoke_error" }> => c.type === "invoke_error",
    );
    expect(err?.code).toBe("insufficient_balance");
  });

  it("maps 403 → unauthorized", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ code: "AUTHZ_DEVICE_NOT_AUTHORIZED", error: "not allowed" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const err = chunks.find(
      (c): c is Extract<StreamChunk, { type: "invoke_error" }> => c.type === "invoke_error",
    );
    expect(err?.code).toBe("unauthorized");
  });

  it("maps 429 → rate_limited with retryAfterSeconds", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ code: "RATE_LIMIT_EXCEEDED", error: "slow down" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "42" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const err = chunks.find(
      (c): c is Extract<StreamChunk, { type: "invoke_error" }> => c.type === "invoke_error",
    );
    expect(err?.code).toBe("rate_limited");
    expect(err?.retryAfterSeconds).toBe(42);
  });

  it("maps 400 → malformed_request (code bug, surfaced loudly)", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ code: "TASK_INVALID_INPUT", error: "bad request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const err = chunks.find(
      (c): c is Extract<StreamChunk, { type: "invoke_error" }> => c.type === "invoke_error",
    );
    expect(err?.code).toBe("malformed_request");
  });

  it("maps network failure → network_unreachable", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async () => {
      throw new TypeError("fetch failed: ENOTFOUND");
    };
    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const err = chunks.find(
      (c): c is Extract<StreamChunk, { type: "invoke_error" }> => c.type === "invoke_error",
    );
    expect(err?.code).toBe("network_unreachable");
  });

  it("maps auth-token mint failure → auth_expired", async () => {
    const rt = enabledRuntime({
      authToken: async () => {
        throw new Error("keyring locked");
      },
    });
    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const err = chunks.find(
      (c): c is Extract<StreamChunk, { type: "invoke_error" }> => c.type === "invoke_error",
    );
    expect(err?.code).toBe("auth_expired");
  });

  // ── In-flight failures ──────────────────────────────────────────────

  it("maps polling timeout → timeout", async () => {
    const rt = enabledRuntime({ timeoutMs: 3000 });
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "t-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Always pending — no receipt ever.
      return new Response(JSON.stringify({ task: { status: "running" }, receipt: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const err = chunks.find(
      (c): c is Extract<StreamChunk, { type: "invoke_error" }> => c.type === "invoke_error",
    );
    expect(err?.code).toBe("timeout");
  }, 10_000);

  it("maps task.status=failed (no receipt) → agent_failed", async () => {
    const rt = enabledRuntime({ timeoutMs: 10_000 });
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "t-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ task: { status: "failed" }, receipt: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const err = chunks.find(
      (c): c is Extract<StreamChunk, { type: "invoke_error" }> => c.type === "invoke_error",
    );
    expect(err?.code).toBe("agent_failed");
  });

  // ── Result-time: receipt.status === "failed" emerges as is-failed bubble ──

  it("returns a receipt with status=failed (bubble renders in is-failed state)", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ task_id: "t-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          task: { status: "failed" },
          receipt: fakeReceipt({ status: "failed", result: "agent returned an error" }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const chunks = await collect(rt.invokeCapability("review_pr", "url"));
    const final = chunks[chunks.length - 1];
    expect(final).toBeDefined();
    if (final) {
      expect(final.type).toBe("delegation_complete");
      if (final.type === "delegation_complete") {
        expect(final.full_receipt?.status).toBe("failed");
      }
    }
    // No invoke_error — the receipt is meaningful evidence, not a failure-to-deliver.
    expect(chunks.find((c) => c.type === "invoke_error")).toBeUndefined();
  });

  // ── Provenance: scheduled/agent-to-agent overrides ──────────────────

  it("honors an explicit invocationOrigin override (e.g. scheduled)", async () => {
    const rt = enabledRuntime();
    mockFetchHandler = async (_url, init) => {
      if (init?.method === "POST") {
        capturedSubmissionBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ task_id: "t-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ task: { status: "completed" }, receipt: fakeReceipt() }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    await collect(rt.invokeCapability("review_pr", "url", { invocationOrigin: "scheduled" }));
    expect(capturedSubmissionBody?.invocation_origin).toBe("scheduled");
  });
});

// Silence unused-import lint in this file — referenced only for parity with
// the interactive-delegation test fixtures if future tests need them.
void InMemoryAgentTrustStore;
