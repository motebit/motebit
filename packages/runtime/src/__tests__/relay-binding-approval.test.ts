/**
 * Approval resume under the one relay binding (design
 * runtime-relay-binding rev 6 §3.2; section 5 tests 5a–5e, the direct
 * handler test, and test 11).
 *
 * A tool call approved under one binding generation must not run under
 * another: it is refused `relay_changed`, nothing is sent, and the tool's
 * handler is never invoked. The streaming step compares generations
 * synchronously immediately before invoking the handler (after the
 * decision sink and the yielded `calling` chunk), and each delegation
 * handler compares the approved generation with its own snapshot — so each
 * of the two checks is caught by a different test here when removed:
 *
 *   - a non-delegation tool has only the streaming check (5a / 5e repeated);
 *   - the direct handler test has only the handler check.
 *
 * Handlers are spied by wrapping every registration; the relays are the
 * `.invalid` fakes from `helpers/two-relays.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ToolDefinition, ToolHandler } from "@motebit/sdk";
import { RiskLevel } from "@motebit/sdk";
import {
  bytesToHex,
  generateKeypair,
  signDelegation,
  signStandingDelegation,
} from "@motebit/crypto";
import { SimpleToolRegistry } from "../simple-tool-registry.js";
import { OWNER_CALL } from "../turn-principal.js";
import { SIGNING_PINNED_HEX } from "./helpers/signed-relay-metadata.js";
import { runToolHandler } from "./helpers/money-tool-handler.js";
import {
  RELAY_A,
  RELAY_B,
  installTwoRelays,
  tokenSource,
  type RelayName,
  type TwoRelays,
} from "./helpers/two-relays.js";

const ME = "approver-001";
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

/** A provider that proposes `tool(args)` once, then answers in text. */
function proposing(tool: string, args: Record<string, unknown>): StreamingProvider {
  const gen = (ctx: ContextPack): AIResponse => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (!history.includes("tool_result") && !history.includes('"role":"tool"')) {
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

const DELEGATE_ARGS = { prompt: "research X", required_capabilities: ["web_search"] };

function bind(
  runtime: MotebitRuntime,
  relay: RelayName,
  extra: { ack?: boolean | (() => boolean); key?: boolean; source?: RelayName } = {},
): void {
  runtime.bindRelay({
    syncUrl: relay === "A" ? RELAY_A : RELAY_B,
    authToken: tokenSource(extra.source ?? relay),
    ...(extra.key === true ? { relayPublicKey: SIGNING_PINNED_HEX } : {}),
    ...(extra.ack != null ? { acknowledgeNoHistoryRisk: extra.ack } : {}),
    tools: true,
    invokeCapability: true,
  });
}

function setup(tool: "delegate_to_agent" | "write_note") {
  let sink: (() => void) | null = null;
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
      onApprovalDecision: () => sink?.(),
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: proposing(tool, tool === "delegate_to_agent" ? DELEGATE_ARGS : {}),
    },
  );
  runtime.getToolRegistry().register(NOTE, async () => ({ ok: true, data: "noted" }));
  bind(runtime, "A");
  return {
    runtime,
    /** Rebind from inside the approval-decision sink (called during the resume). */
    onDecision: (fn: () => void) => {
      sink = fn;
    },
  };
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

async function paused(runtime: MotebitRuntime): Promise<void> {
  const chunks = await drain(runtime.sendMessageStreaming("please do it"));
  expect(chunks.some((c) => c.type === "approval_request")).toBe(true);
}

function doneResult(chunks: StreamChunk[], tool: string): string {
  const done = chunks.find(
    (c) => c.type === "tool_status" && c.status === "done" && c.name === tool,
  ) as { result?: unknown } | undefined;
  const result = done?.result;
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

let relays: TwoRelays;
beforeEach(() => {
  invoked.clear();
  relays = installTwoRelays(ME);
});
afterEach(() => {
  relays.restore();
});

describe.each([["delegate_to_agent" as const], ["write_note" as const]])(
  "approved %s across a rebind",
  (tool) => {
    it("(a) rebind to B, then approve: relay_changed, nothing sent, handler not invoked", async () => {
      const { runtime } = setup(tool);
      await paused(runtime);
      bind(runtime, "B");
      const sent = relays.requests.length;

      const chunks = await drain(runtime.resumeAfterApproval(true));
      expect(doneResult(chunks, tool)).toContain("relay_changed");
      expect(invoked.get(tool) ?? 0).toBe(0);
      expect(relays.requests.slice(sent)).toEqual([]);
    });

    it("(e) approve, hold the yielded `calling` chunk, rebind to B, continue: relay_changed", async () => {
      const { runtime } = setup(tool);
      await paused(runtime);
      const sent = relays.requests.length;

      const resume = runtime.resumeAfterApproval(true);
      const seen: StreamChunk[] = [];
      for (;;) {
        const next = await resume.next();
        if (next.done === true) break;
        seen.push(next.value);
        if (next.value.type === "tool_status" && next.value.status === "calling") break;
      }
      expect(seen.some((c) => c.type === "tool_status" && c.status === "calling")).toBe(true);
      bind(runtime, "B");
      for (;;) {
        const next = await resume.next();
        if (next.done === true) break;
        seen.push(next.value);
      }
      expect(doneResult(seen, tool)).toContain("relay_changed");
      expect(invoked.get(tool) ?? 0).toBe(0);
      expect(relays.requests.slice(sent)).toEqual([]);
    });
  },
);

describe("approved delegate_to_agent: the other generation changes", () => {
  const tool = "delegate_to_agent";

  it("(b) approve, and rebind to B from inside the decision sink: relay_changed", async () => {
    const { runtime, onDecision } = setup(tool);
    await paused(runtime);
    onDecision(() => bind(runtime, "B"));
    const sent = relays.requests.length;

    const chunks = await drain(runtime.resumeAfterApproval(true));
    expect(runtime.getDelegationRelay()?.url).toBe(RELAY_B);
    expect(doneResult(chunks, tool)).toContain("relay_changed");
    expect(invoked.get(tool) ?? 0).toBe(0);
    expect(relays.requests.slice(sent)).toEqual([]);
  });

  it("(c) unbind, then rebind to A: denied (the generation changed)", async () => {
    const { runtime } = setup(tool);
    await paused(runtime);
    runtime.unbindRelay();
    bind(runtime, "A");
    const sent = relays.requests.length;

    const chunks = await drain(runtime.resumeAfterApproval(true));
    expect(doneResult(chunks, tool)).toContain("relay_changed");
    expect(invoked.get(tool) ?? 0).toBe(0);
    expect(relays.requests.slice(sent)).toEqual([]);
  });

  it("(f) the same relay rebound WITH a key (a pin landed): relay_changed, nothing sent", async () => {
    // The money path: approved as relay-mode (no pinned key), it must not run
    // as a paid P2P hire because a key was pinned meanwhile.
    const { runtime } = setup(tool);
    await paused(runtime);
    bind(runtime, "A", { key: true });
    const sent = relays.requests.length;

    const chunks = await drain(runtime.resumeAfterApproval(true));
    expect(doneResult(chunks, tool)).toContain("relay_changed");
    expect(invoked.get(tool) ?? 0).toBe(0);
    expect(relays.requests.slice(sent)).toEqual([]);
  });

  it("(d) the same values rebound: the approved call runs", async () => {
    const { runtime } = setup(tool);
    await paused(runtime);
    bind(runtime, "A");

    const chunks = await drain(runtime.resumeAfterApproval(true));
    expect(doneResult(chunks, tool)).not.toContain("relay_changed");
    expect(invoked.get(tool)).toBe(1);
    expect(relays.to("A").some((r) => r.method === "POST")).toBe(true);
    expect(relays.to("B")).toEqual([]);
  }, 20_000);
});

describe("approved write_note across an unbind with no rebind", () => {
  it("(g) unbind, then approve: relay_changed, handler not invoked", async () => {
    const { runtime } = setup("write_note");
    await paused(runtime);
    runtime.unbindRelay();

    const chunks = await drain(runtime.resumeAfterApproval(true));
    expect(doneResult(chunks, "write_note")).toContain("relay_changed");
    expect(invoked.get("write_note") ?? 0).toBe(0);
  });
});

describe("each delegation handler checks the approved generation itself", () => {
  it.each([
    ["delegate_to_agent", DELEGATE_ARGS],
    ["discover_agents", {}],
    ["retrieve_task_result", { task_id: "task-1" }],
  ])(
    "%s called with a stale approved generation: relay_changed, nothing sent",
    async (name, args) => {
      const { runtime } = setup("write_note");
      // Generation now: one bind. A call approved under any other is stale.
      const before = relays.requests.length;
      const stale = await runToolHandler(runtime.getToolRegistry(), name, args, {
        ...OWNER_CALL,
        approvedRelayGeneration: -1,
      });
      expect(stale.ok).toBe(false);
      expect(stale.error).toContain("relay_changed");
      expect(relays.requests.slice(before)).toEqual([]);
    },
  );
});

describe("test 11 — same-relay rebind with a changed acknowledgement", () => {
  it("keeps the generation (a pending approval still runs) and uses the new value", async () => {
    const { runtime } = setup("write_note");
    bind(runtime, "A", { key: true, ack: false });
    await paused(runtime);
    // Same relay, same key, same paths — only the acknowledgement changes.
    bind(runtime, "A", { key: true, ack: () => true });

    const chunks = await drain(runtime.resumeAfterApproval(true));
    expect(doneResult(chunks, "write_note")).toContain("noted");
    expect(doneResult(chunks, "write_note")).not.toContain("relay_changed");
    expect(invoked.get("write_note")).toBe(1);

    // The new acknowledgement is what the next call reads: a granted dry run
    // asks the relay's eligibility WITH the acknowledgement.
    const now = Date.now();
    const pub = bytesToHex(KEYS.publicKey);
    const grant = await signStandingDelegation(
      {
        grant_id: "grant-ack-1",
        delegator_id: ME,
        delegator_public_key: pub,
        delegate_id: ME,
        delegate_public_key: pub,
        scope: "delegate_to_agent",
        subject: "market:capability=web_search",
        cadence_ms: 86_400_000,
        issued_at: now,
        not_before: null,
        expires_at: now + 86_400_000,
        max_token_ttl_ms: 3_600_000,
        spend_ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 10_000_000 },
      },
      KEYS.privateKey,
    );
    const token = await signDelegation(
      {
        delegator_id: ME,
        delegator_public_key: pub,
        delegate_id: ME,
        delegate_public_key: pub,
        scope: grant.scope,
        issued_at: now,
        expires_at: now + 3_600_000,
        grant_id: grant.grant_id,
      },
      KEYS.privateKey,
    );
    const seen: string[] = [];
    const recordingFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return recordingFetch(input, init);
    }) as typeof fetch;
    const dry = await runtime.executeGrantedDelegation({
      capability: "web_search",
      prompt: "survey",
      delegation: { token, grant },
      dryRun: true,
    });
    globalThis.fetch = recordingFetch;
    expect(dry.ok).toBe(true);
    const eligibility = seen.find((u) => u.includes("/p2p-eligibility"));
    expect(eligibility).toContain("acknowledge_no_history_risk=true");
  });
});
