/**
 * A served task whose model stream is cut mid-emoji (a provider error after a
 * text chunk that ends in a lone high surrogate) still yields a receipt every
 * strict verifier accepts: the producer never emits an unpaired surrogate
 * (spec/execution-ledger-v1.md §11.4) — it repairs it to U+FFFD before hashing
 * and signing, so `result_hash` binds exactly the signed `result`.
 */
import { describe, expect, it, vi } from "vitest";
import { generateKeypair, verifyExecutionReceipt, verifyReceipt } from "@motebit/encryption";
import type { AgentTask, ExecutionReceipt } from "@motebit/sdk";
import { AgentTaskStatus } from "@motebit/sdk";
import { handleAgentTask } from "../agent-task-handler.js";
import type { AgentTaskHandlerDeps } from "../agent-task-handler.js";
import type { StreamChunk } from "../index.js";

const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function deps(stream: () => AsyncGenerator<StreamChunk>): AgentTaskHandlerDeps {
  return {
    motebitId: "motebit-test-id",
    events: {
      appendWithClock: vi.fn().mockResolvedValue(1),
      append: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      getLatestClock: vi.fn().mockResolvedValue(0),
      tombstone: vi.fn(),
    } as never,
    agentTrustStore: null,
    agentGraph: { addReceiptEdges: vi.fn().mockResolvedValue(undefined) } as never,
    latencyStatsStore: null,
    logger: { warn: vi.fn() },
    sendMessageStreaming: vi.fn().mockImplementation(stream),
    bumpTrustFromReceipt: vi.fn().mockResolvedValue(undefined),
  };
}

const task = {
  task_id: "task-cut",
  motebit_id: "motebit-test-id",
  prompt: "write a greeting",
  submitted_at: Date.now() - 1000,
  status: AgentTaskStatus.Claimed,
  capabilities: [],
} as unknown as AgentTask;

describe("handleAgentTask — receipt result is well-formed Unicode", () => {
  const full = "hi 😀 there 👍🏽";
  for (let i = 0; i <= full.length; i++) {
    it(`stream cut after ${i} code units → strict-valid receipt`, async () => {
      const kp = await generateKeypair();
      const cut = full.slice(0, i);
      async function* broken(): AsyncGenerator<StreamChunk> {
        yield { type: "text", text: cut };
        throw new Error("provider stream reset");
      }
      let receipt: ExecutionReceipt | undefined;
      for await (const chunk of handleAgentTask(
        deps(broken),
        task,
        kp.privateKey,
        "device-001",
        kp.publicKey,
      )) {
        if (chunk.type === "task_result") receipt = chunk.receipt as ExecutionReceipt;
      }
      expect(receipt).toBeDefined();
      expect(UNPAIRED.test(receipt!.result)).toBe(false);
      expect(await verifyExecutionReceipt(receipt!, kp.publicKey)).toBe(true);
      expect((await verifyReceipt(receipt!, { strictHashBinding: true })).valid).toBe(true);
    });
  }
});
