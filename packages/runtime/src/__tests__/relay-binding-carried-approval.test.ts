/**
 * A carried approval under the one relay binding (design
 * runtime-relay-binding 4b §2 "The runtime refuses, not only the gate",
 * "invokeLocalTool takes approvedUnderRelay", "Recovered approvals carry
 * their relay"; §3 change 1).
 *
 *   - The AI loop stamps the bound relay's identity and the registry's
 *     relay-bound flag on every `approval_request` (turns and, through the
 *     same loop deps, plan steps); an unpinnable URL stamps `null`.
 *   - `invokeLocalTool(humanApproved)` on a relay-bound tool runs only with
 *     an `approvedUnderRelay` that names the bound relay. The runtime turns
 *     it into the binding generation itself; a rebind that lands after the
 *     comparison is refused by the handler's own check.
 *
 * Handlers are counted by wrapping every registration (the relay-bound
 * registrations go through `register` too). The relays are the `.invalid`
 * fakes from `helpers/two-relays.ts`. Ephemeral keys only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ToolDefinition, ToolHandler } from "@motebit/sdk";
import { RiskLevel } from "@motebit/sdk";
import { generateKeypair } from "@motebit/crypto";
import { SimpleToolRegistry } from "../simple-tool-registry.js";
import type { ToolCall } from "../turn-principal.js";
import {
  RELAY_A,
  RELAY_B,
  installTwoRelays,
  tokenSource,
  type TwoRelays,
} from "./helpers/two-relays.js";

const ME = "carrier-001";
const KEYS = await generateKeypair();

// --- handler spies: every handler registered from here on is counted ---
const invoked = new Map<string, number>();
const proto = SimpleToolRegistry.prototype;
const originalRegister = proto.register;
proto.register = function (this: SimpleToolRegistry, tool: ToolDefinition, handler: ToolHandler) {
  const counted: ToolHandler = (...args: Parameters<ToolHandler>) => {
    invoked.set(tool.name, (invoked.get(tool.name) ?? 0) + 1);
    return (handler as (...a: Parameters<ToolHandler>) => ReturnType<ToolHandler>)(...args);
  };
  originalRegister.call(this, tool, counted);
};

const NOTE: ToolDefinition = {
  name: "write_note",
  mode: "api",
  description: "Write a note on this device",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R2_WRITE },
};

const DELEGATE_ARGS = { prompt: "research X", required_capabilities: ["web_search"] };
const UNPINNABLE = "https://relay-a.invalid/?x=1";

function proposing(tool: string, args: Record<string, unknown>): StreamingProvider {
  const gen = (ctx: ContextPack): AIResponse => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (!history.includes('"role":"tool"')) {
      return {
        text: "",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "c1", name: tool, args }],
      };
    }
    return { text: "done", confidence: 0.8, memory_candidates: [], state_updates: {} };
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: ContextPack) => gen(ctx)),
    estimateConfidence: vi.fn(async () => 0.8),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      const response = gen(ctx);
      if (response.text) yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

function bind(runtime: MotebitRuntime, relay: string): void {
  runtime.bindRelay({
    syncUrl: relay === "A" ? RELAY_A : relay === "B" ? RELAY_B : relay,
    authToken: tokenSource(relay === "B" ? "B" : "A"),
    tools: true,
    invokeCapability: true,
  });
}

function setup(tool: "delegate_to_agent" | "write_note" = "write_note"): MotebitRuntime {
  const runtime = new MotebitRuntime(
    {
      motebitId: ME,
      tickRateHz: 0,
      signingKeys: KEYS,
      // Every write pauses for the human.
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R4_MONEY,
        requireApprovalAbove: RiskLevel.R1_DRAFT,
        denyAbove: RiskLevel.R4_MONEY,
      },
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: proposing(tool, tool === "delegate_to_agent" ? DELEGATE_ARGS : {}),
    },
  );
  runtime.getToolRegistry().register(NOTE, async () => ({ ok: true, data: "noted" }));
  return runtime;
}

async function approvalOf(
  runtime: MotebitRuntime,
): Promise<Extract<StreamChunk, { type: "approval_request" }>> {
  for await (const c of runtime.sendMessageStreaming("please do it")) {
    if (c.type === "approval_request") return c;
  }
  throw new Error("no approval_request");
}

let relays: TwoRelays;
beforeEach(() => {
  invoked.clear();
  relays = installTwoRelays(ME);
});
afterEach(() => {
  relays.restore();
});

describe("the relay stamp on approval_request", () => {
  it("a turn's delegate_to_agent pause names the bound relay and is relay-bound", async () => {
    const runtime = setup("delegate_to_agent");
    bind(runtime, "A");
    const chunk = await approvalOf(runtime);
    expect(chunk.relay).toEqual({ pinKey: RELAY_A, publicKey: null });
    expect(chunk.relay_bound).toBe(true);
  });

  it("a local tool's pause names the relay and is not relay-bound", async () => {
    const runtime = setup("write_note");
    bind(runtime, "A");
    const chunk = await approvalOf(runtime);
    expect(chunk.relay).toEqual({ pinKey: RELAY_A, publicKey: null });
    expect(chunk.relay_bound).toBe(false);
  });

  it("an unpinnable relay URL stamps null on turns and on the plan-step loop deps", async () => {
    const runtime = setup("delegate_to_agent");
    bind(runtime, UNPINNABLE);
    const chunk = await approvalOf(runtime);
    expect(chunk.relay).toBeNull();
    expect(chunk.relay_bound).toBe(true);
    // Plan steps stream from ai-core with the runtime's loop deps.
    const deps = runtime.getLoopDeps();
    expect(deps?.relayIdentity?.()).toBeNull();
    expect(deps?.isRelayBoundTool?.("delegate_to_agent")).toBe(true);
  });

  it("an unbound runtime stamps null", async () => {
    const runtime = setup("write_note");
    const chunk = await approvalOf(runtime);
    expect(chunk.relay).toBeNull();
    expect(chunk.relay_bound).toBe(false);
  });
});

describe("invokeLocalTool with a carried approval for a relay-bound tool", () => {
  it("humanApproved with no approvedUnderRelay: refused relay_changed, handler not invoked", async () => {
    const runtime = setup();
    bind(runtime, "B");
    const before = relays.requests.length;
    const r = await runtime.invokeLocalTool("delegate_to_agent", DELEGATE_ARGS, {
      invocationOrigin: "scheduled",
      humanApproved: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("relay_changed");
    expect(invoked.get("delegate_to_agent") ?? 0).toBe(0);
    expect(relays.requests.slice(before)).toEqual([]);
  });

  it("approvedUnderRelay naming another relay: refused before execute, handler not invoked", async () => {
    const runtime = setup();
    bind(runtime, "B");
    const before = relays.requests.length;
    const r = await runtime.invokeLocalTool("delegate_to_agent", DELEGATE_ARGS, {
      invocationOrigin: "scheduled",
      humanApproved: true,
      approvedUnderRelay: { pinKey: RELAY_A, publicKey: null },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("relay_changed");
    expect(invoked.get("delegate_to_agent") ?? 0).toBe(0);
    expect(relays.requests.slice(before)).toEqual([]);
  });

  it("approvedUnderRelay naming the bound relay with another key: refused", async () => {
    const runtime = setup();
    bind(runtime, "A");
    const r = await runtime.invokeLocalTool("delegate_to_agent", DELEGATE_ARGS, {
      invocationOrigin: "scheduled",
      humanApproved: true,
      approvedUnderRelay: { pinKey: RELAY_A, publicKey: "ab".repeat(32) },
    });
    expect(r.error).toContain("relay_changed");
    expect(invoked.get("delegate_to_agent") ?? 0).toBe(0);
  });

  it("an unpinnable binding never matches: refused", async () => {
    const runtime = setup();
    bind(runtime, UNPINNABLE);
    const r = await runtime.invokeLocalTool("delegate_to_agent", DELEGATE_ARGS, {
      invocationOrigin: "scheduled",
      humanApproved: true,
      approvedUnderRelay: { pinKey: UNPINNABLE, publicKey: null },
    });
    expect(r.error).toContain("relay_changed");
    expect(invoked.get("delegate_to_agent") ?? 0).toBe(0);
  });

  it("approvedUnderRelay naming the bound relay: the handler runs with the generation", async () => {
    const runtime = setup();
    bind(runtime, "A");
    const calls: Array<ToolCall | undefined> = [];
    const registry = runtime.getToolRegistry();
    const execute = registry.execute.bind(registry);
    registry.execute = async (n, a, c) => {
      calls.push(c);
      return execute(n, a, c);
    };
    await runtime.invokeLocalTool("delegate_to_agent", DELEGATE_ARGS, {
      invocationOrigin: "scheduled",
      humanApproved: true,
      approvedUnderRelay: { pinKey: RELAY_A, publicKey: null },
    });
    expect(invoked.get("delegate_to_agent")).toBe(1);
    expect(calls).toHaveLength(1);
    expect(typeof calls[0]?.approvedRelayGeneration).toBe("number");
    expect(relays.to("B")).toEqual([]);
  }, 20_000);

  it("a rebind after the comparison is refused by the handler: nothing reaches B", async () => {
    const runtime = setup();
    bind(runtime, "A");
    const registry = runtime.getToolRegistry();
    const execute = registry.execute.bind(registry);
    // Lands after invokeLocalTool compared the relay, before the handler.
    registry.execute = async (n, a, c) => {
      bind(runtime, "B");
      return execute(n, a, c);
    };
    const r = await runtime.invokeLocalTool("delegate_to_agent", DELEGATE_ARGS, {
      invocationOrigin: "scheduled",
      humanApproved: true,
      approvedUnderRelay: { pinKey: RELAY_A, publicKey: null },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("relay_changed");
    expect(relays.to("B")).toEqual([]);
    expect(relays.tokened()).toEqual([]);
  });

  it("a local tool's carried approval needs no relay and runs as before", async () => {
    const runtime = setup();
    bind(runtime, "A");
    const r = await runtime.invokeLocalTool(
      "write_note",
      {},
      {
        invocationOrigin: "scheduled",
        humanApproved: true,
      },
    );
    expect(r.ok).toBe(true);
    expect(invoked.get("write_note")).toBe(1);
  });
});
