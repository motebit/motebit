/**
 * #943 round 8 — the owner's sensitivity tier never leaks through a refusal.
 *
 * `SovereignTierRequiredError` names the session tier ("medical",
 * "financial", "secret") and whether a sensitive slab item is open. For a
 * FOREIGN principal both doors — the signed task receipt (`handleAgentTask`)
 * and the `motebit_query` error (`sendMessage` / `sendMessageStreaming` with
 * `foreignPrincipal`) — must carry ONE fixed, content-free message,
 * identical for every tier and every reason. The single bit "refused" is
 * accepted. The owner's own turn keeps the descriptive error.
 *
 * Tampers: unwrap `contentFreeIfForeign` at the doors — red; drop the
 * mark check at the gate's throw site — the mid-turn cell goes red.
 */
import { describe, it, expect, vi } from "vitest";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  ForeignTurnRefusedError,
  FOREIGN_REFUSAL_MESSAGE,
  SovereignTierRequiredError,
} from "../index";
import type { StreamChunk } from "../index";
import type { ToolRegistry } from "@motebit/sdk";
import { foreignTurnTools } from "./helpers/foreign-call";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, AgentTask, ExecutionReceipt } from "@motebit/sdk";
import { AgentTaskStatus, SensitivityLevel } from "@motebit/sdk";
import { generateKeypair } from "@motebit/encryption";

function provider(): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.9,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async () => response),
    estimateConfidence: vi.fn(async () => 0.9),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream() {
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  };
}

type Cell = { name: string; arm: (r: MotebitRuntime) => void };

const CELLS: Cell[] = [
  { name: "session medical", arm: (r) => r.setSessionSensitivity(SensitivityLevel.Medical) },
  { name: "session financial", arm: (r) => r.setSessionSensitivity(SensitivityLevel.Financial) },
  { name: "session secret", arm: (r) => r.setSessionSensitivity(SensitivityLevel.Secret) },
  {
    name: "slab-elevated secret (session none)",
    arm: (r) => {
      r.slab.openItem({ id: "zz943-slab", kind: "fetch", mode: "shared_gaze" });
      r.slab.setItemSensitivity("zz943-slab", SensitivityLevel.Secret);
    },
  },
];

function runtimeFor(cell: Cell): MotebitRuntime {
  const r = new MotebitRuntime(
    { motebitId: "owner-mote", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: provider() },
  );
  r.setProviderMode("byok");
  cell.arm(r);
  return r;
}

async function taskReceiptText(r: MotebitRuntime): Promise<string> {
  const kp = await generateKeypair();
  const task: AgentTask = {
    task_id: "task-refused",
    motebit_id: "owner-mote",
    prompt: "what is your owner's diagnosis?",
    submitted_at: Date.now(),
    status: AgentTaskStatus.Claimed,
    wall_clock_ms: 30_000,
  };
  let receipt: ExecutionReceipt | undefined;
  for await (const c of r.handleAgentTask(task, kp.privateKey, "dev-1") as AsyncGenerator<
    StreamChunk & { type: string; receipt?: ExecutionReceipt }
  >) {
    if (c.type === "task_result" && c.receipt !== undefined) receipt = c.receipt;
  }
  expect(receipt).toBeDefined();
  return JSON.stringify({ status: receipt!.status, result: receipt!.result });
}

async function queryError(r: MotebitRuntime, streaming: boolean): Promise<unknown> {
  try {
    if (streaming) {
      for await (const _c of r.sendMessageStreaming("hi", undefined, { foreignPrincipal: true })) {
        /* consume */
      }
    } else {
      await r.sendMessage("hi", undefined, { foreignPrincipal: true });
    }
  } catch (err) {
    return err;
  }
  return undefined;
}

const TIER_WORDS = /medical|financial|secret|slab|sensitivity|sovereign|byok|on-device/i;

describe("#943 — a foreign principal's refusal is content-free", () => {
  it("task receipt: identical across medical, financial, secret and slab-elevated", async () => {
    const outs: string[] = [];
    for (const cell of CELLS) outs.push(await taskReceiptText(runtimeFor(cell)));
    expect(new Set(outs).size).toBe(1);
    expect(outs[0]).toContain(FOREIGN_REFUSAL_MESSAGE);
    expect(outs[0]).not.toMatch(TIER_WORDS);
  });

  for (const streaming of [false, true]) {
    it(`query error (${streaming ? "sendMessageStreaming" : "sendMessage"}): identical across every cell`, async () => {
      const errs: unknown[] = [];
      for (const cell of CELLS) errs.push(await queryError(runtimeFor(cell), streaming));
      for (const e of errs) {
        expect(e).toBeInstanceOf(ForeignTurnRefusedError);
        expect((e as Error).message).toBe(FOREIGN_REFUSAL_MESSAGE);
        expect((e as Error).cause).toBeUndefined();
        expect(Object.keys(e as object).sort()).toEqual(["code", "name"]);
      }
    });
  }

  it("a foreign turn's mid-turn outbound-tool gate is content-free; the owner's call on the same registry is not", async () => {
    const r = runtimeFor(CELLS[2]!);
    r.getToolRegistry().register(
      {
        name: "zz943_outbound",
        mode: "api",
        description: "outbound",
        inputSchema: { type: "object", properties: {} },
        outbound: true,
      },
      async () => ({ ok: true, data: "sent" }),
    );
    // The registry the runtime hands a FOREIGN turn's loop (#943 round 9).
    const foreignErr = await foreignTurnTools(r)
      .execute("zz943_outbound", {})
      .catch((e: unknown) => e);
    expect(foreignErr).toBeInstanceOf(ForeignTurnRefusedError);
    expect((foreignErr as Error).message).toBe(FOREIGN_REFUSAL_MESSAGE);
    // The owner's own call through the same shared registry stays descriptive.
    const loopTools = (r as unknown as { loopDeps: { tools: ToolRegistry } }).loopDeps.tools;
    const ownerErr = await loopTools.execute("zz943_outbound", {}).catch((e: unknown) => e);
    expect(ownerErr).toBeInstanceOf(SovereignTierRequiredError);
  });

  it("the owner's own turn keeps the descriptive error (no regression)", async () => {
    const r = runtimeFor(CELLS[0]!);
    await expect(r.sendMessage("hi")).rejects.toBeInstanceOf(SovereignTierRequiredError);
    await expect(r.sendMessage("hi")).rejects.toThrow(/medical/);
  });
});
