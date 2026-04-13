import { describe, it, expect, vi } from "vitest";
import { SovereignDelegationAdapter } from "../sovereign-delegation-adapter.js";
import type { SovereignDelegationConfig } from "../sovereign-delegation-adapter.js";
import type { PlanStep, ExecutionReceipt } from "@motebit/sdk";
import { StepStatus, DeviceCapability, asPlanId } from "@motebit/sdk";

// ── Test helpers ────────────────────────────────────────────────────

function makeStep(overrides?: Partial<PlanStep>): PlanStep {
  return {
    step_id: "step-1",
    plan_id: asPlanId("plan-1"),
    ordinal: 0,
    description: "test step",
    prompt: "do the thing",
    depends_on: [],
    optional: false,
    status: StepStatus.Pending,
    required_capabilities: [DeviceCapability.HttpMcp],
    result_summary: null,
    error_message: null,
    tool_calls_made: 0,
    started_at: null,
    completed_at: null,
    retry_count: 0,
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeReceipt(overrides?: Partial<ExecutionReceipt>): ExecutionReceipt {
  return {
    task_id: "solana:tx:5x9Kq",
    motebit_id: "agent-bob",
    public_key: "ab".repeat(32),
    device_id: "device-bob",
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    status: "completed",
    result: "task completed successfully",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "abc",
    result_hash: "def",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig123",
    ...overrides,
  } as ExecutionReceipt;
}

function makeConfig(overrides?: Partial<SovereignDelegationConfig>): SovereignDelegationConfig {
  return {
    discoveryUrl: "https://relay.test",
    motebitId: "agent-alice",
    deviceId: "device-alice",
    signingKeys: {
      privateKey: new Uint8Array(32),
      publicKey: new Uint8Array(32),
    },
    walletRail: {
      send: vi.fn().mockResolvedValue({ signature: "tx-hash-123" }),
      chain: "solana",
      asset: "USDC",
    },
    createSignedToken: vi.fn().mockResolvedValue("mock-token"),
    verifyReceipt: vi.fn().mockResolvedValue(true),
    hexToBytes: vi.fn().mockReturnValue(new Uint8Array(32)),
    hash: vi.fn().mockResolvedValue("hash-abc"),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SovereignDelegationAdapter", () => {
  it("happy path: discover → pay → execute → receipt", async () => {
    const receipt = makeReceipt();
    const config = makeConfig();

    // Mock fetch: first call = discovery, second = MCP initialize, third = MCP notification, fourth = MCP tools/call
    const fetchMock = vi
      .fn()
      // Discovery
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [
              {
                motebit_id: "agent-bob",
                composite: 0.9,
                endpoint_url: "https://bob.test/mcp",
                pay_to_address: "BobSolanaAddr123",
                pricing: [
                  { capability: "web_search", unit_cost: 500000, currency: "USD", per: "task" },
                ],
                is_online: true,
              },
            ],
          }),
      } as unknown as Response)
      // MCP initialize
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "mcp-session-id": "sess-1" }),
        json: () => Promise.resolve({ id: 1, result: { protocolVersion: "2025-03-26" } }),
        text: () => Promise.resolve(""),
      } as unknown as Response)
      // MCP initialized notification
      .mockResolvedValueOnce({ ok: true } as Response)
      // MCP tools/call
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            id: 2,
            result: {
              content: [{ type: "text", text: JSON.stringify(receipt) }],
            },
          }),
        text: () => Promise.resolve(""),
      } as unknown as Response);

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SovereignDelegationAdapter(config);
    const result = await adapter.delegateStep(makeStep(), 30000);

    expect(result.receipt.status).toBe("completed");
    expect(result.receipt.motebit_id).toBe("agent-bob");
    expect(result.task_id).toContain("sovereign:");
    expect(config.walletRail.send).toHaveBeenCalledWith("BobSolanaAddr123", 500000n);

    vi.unstubAllGlobals();
  });

  it("throws when no candidates found", async () => {
    const config = makeConfig();
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ candidates: [] }),
    } as unknown as Response);

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SovereignDelegationAdapter(config);
    await expect(adapter.delegateStep(makeStep(), 30000)).rejects.toThrow("No candidates");

    vi.unstubAllGlobals();
  });

  it("throws with failedAgentId when payment fails", async () => {
    const config = makeConfig({
      walletRail: {
        send: vi.fn().mockRejectedValue(new Error("Insufficient USDC balance")),
        chain: "solana",
        asset: "USDC",
      },
    });

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          candidates: [
            {
              motebit_id: "agent-bob",
              composite: 0.9,
              endpoint_url: "https://bob.test/mcp",
              pay_to_address: "BobAddr",
              pricing: [
                { capability: "web_search", unit_cost: 500000, currency: "USD", per: "task" },
              ],
              is_online: true,
            },
          ],
        }),
    } as unknown as Response);

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SovereignDelegationAdapter(config);
    await expect(adapter.delegateStep(makeStep(), 30000)).rejects.toThrow("Payment failed");

    vi.unstubAllGlobals();
  });

  it("throws when receipt signature verification fails", async () => {
    const receipt = makeReceipt();
    const config = makeConfig({
      verifyReceipt: vi.fn().mockResolvedValue(false),
      maxRetries: 0, // No retries — fail on first attempt
    });

    const candidateResp = {
      ok: true,
      json: () =>
        Promise.resolve({
          candidates: [
            {
              motebit_id: "agent-bob",
              composite: 0.9,
              endpoint_url: "https://bob.test/mcp",
              pay_to_address: "BobAddr",
              pricing: [
                { capability: "web_search", unit_cost: 500000, currency: "USD", per: "task" },
              ],
              is_online: true,
            },
          ],
        }),
    } as unknown as Response;

    const fetchMock = vi
      .fn()
      // Discovery
      .mockResolvedValueOnce(candidateResp)
      // MCP initialize
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "mcp-session-id": "sess-1" }),
        json: () => Promise.resolve({ id: 1, result: {} }),
      } as unknown as Response)
      // MCP initialized notification
      .mockResolvedValueOnce({ ok: true } as Response)
      // MCP tools/call
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            id: 2,
            result: { content: [{ type: "text", text: JSON.stringify(receipt) }] },
          }),
      } as unknown as Response);

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SovereignDelegationAdapter(config);
    await expect(adapter.delegateStep(makeStep(), 30000)).rejects.toThrow(
      "signature verification failed",
    );

    vi.unstubAllGlobals();
  });

  it("pollTaskResult always returns null (no relay state)", async () => {
    const adapter = new SovereignDelegationAdapter(makeConfig());
    const result = await adapter.pollTaskResult("task-1", "step-1");
    expect(result).toBeNull();
  });

  it("rejects malformed receipt JSON (missing required fields)", async () => {
    const config = makeConfig({ maxRetries: 0 });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [
              {
                motebit_id: "agent-bob",
                composite: 0.9,
                endpoint_url: "https://bob.test/mcp",
                pay_to_address: "BobAddr",
                pricing: [
                  { capability: "web_search", unit_cost: 500000, currency: "USD", per: "task" },
                ],
                is_online: true,
              },
            ],
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "mcp-session-id": "sess-1" }),
        json: () => Promise.resolve({ id: 1, result: {} }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            id: 2,
            // Missing task_id, motebit_id, signature — should be rejected
            result: { content: [{ type: "text", text: '{"foo": "bar"}' }] },
          }),
      } as unknown as Response);

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SovereignDelegationAdapter(config);
    await expect(adapter.delegateStep(makeStep(), 30000)).rejects.toThrow("no receipt");

    vi.unstubAllGlobals();
  });

  it("calls onDelegationFailure on error", async () => {
    const onFailure = vi.fn();
    const config = makeConfig({
      maxRetries: 0,
      onDelegationFailure: onFailure,
    });

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ candidates: [] }),
    } as unknown as Response);

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SovereignDelegationAdapter(config);
    await expect(adapter.delegateStep(makeStep(), 30000)).rejects.toThrow("No candidates");

    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: "step-1" }),
      0,
      expect.stringContaining("No candidates"),
      undefined,
    );

    vi.unstubAllGlobals();
  });
});
