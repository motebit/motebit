import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { PlatformAdapters, StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import { AgentTaskStatus } from "@motebit/sdk";
import type { AgentTask } from "@motebit/sdk";
import { generateKeypair, verifyExecutionReceipt } from "@motebit/encryption";

// === Mock Provider ===

function createMockProvider(responseText = "Hello from agent task"): StreamingProvider {
  const response: AIResponse = {
    text: responseText,
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
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: responseText };
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

async function getTaskResult(
  gen: AsyncGenerator<StreamChunk>,
): Promise<StreamChunk & { type: "task_result" }> {
  for await (const chunk of gen) {
    if (chunk.type === "task_result") return chunk;
  }
  throw new Error("No task_result chunk found");
}

// === Tests ===

describe("MotebitRuntime.handleAgentTask", () => {
  it("executes task and produces signed receipt", async () => {
    const provider = createMockProvider("The answer is 4");
    const runtime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      createAdapters(provider),
    );

    const keypair = await generateKeypair();
    const task: AgentTask = {
      task_id: "task-001",
      motebit_id: "test-mote",
      prompt: "What is 2+2?",
      submitted_at: Date.now(),
      status: AgentTaskStatus.Claimed,
      wall_clock_ms: 30_000,
    };

    const result = await getTaskResult(
      runtime.handleAgentTask(task, keypair.privateKey, "device-001"),
    );

    expect(result.receipt.task_id).toBe("task-001");
    expect(result.receipt.motebit_id).toBe("test-mote");
    expect(result.receipt.device_id).toBe("device-001");
    expect(result.receipt.status).toBe("completed");
    expect(result.receipt.result).toContain("The answer is 4");
    expect(result.receipt.signature).toBeTruthy();
    expect(result.receipt.prompt_hash).toHaveLength(64);
    expect(result.receipt.result_hash).toHaveLength(64);
  });

  it("receipt signature verifies with public key", async () => {
    const provider = createMockProvider("verified result");
    const runtime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      createAdapters(provider),
    );

    const keypair = await generateKeypair();
    const task: AgentTask = {
      task_id: "task-002",
      motebit_id: "test-mote",
      prompt: "verify me",
      submitted_at: Date.now(),
      status: AgentTaskStatus.Claimed,
    };

    const result = await getTaskResult(
      runtime.handleAgentTask(task, keypair.privateKey, "device-002"),
    );

    const valid = await verifyExecutionReceipt(result.receipt, keypair.publicKey);
    expect(valid).toBe(true);
  });

  it("task status is completed on success", async () => {
    const provider = createMockProvider("success");
    const runtime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      createAdapters(provider),
    );

    const keypair = await generateKeypair();
    const task: AgentTask = {
      task_id: "task-003",
      motebit_id: "test-mote",
      prompt: "do something",
      submitted_at: Date.now(),
      status: AgentTaskStatus.Claimed,
    };

    const result = await getTaskResult(
      runtime.handleAgentTask(task, keypair.privateKey, "device-003"),
    );

    expect(result.receipt.status).toBe("completed");
  });

  it("receipt has no delegation_receipts when no MCP adapters provide them", async () => {
    const provider = createMockProvider("no delegation");
    const runtime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      createAdapters(provider),
    );

    const keypair = await generateKeypair();
    const task: AgentTask = {
      task_id: "task-004",
      motebit_id: "test-mote",
      prompt: "simple task",
      submitted_at: Date.now(),
      status: AgentTaskStatus.Claimed,
    };

    const result = await getTaskResult(
      runtime.handleAgentTask(task, keypair.privateKey, "device-004"),
    );

    // delegation_receipts should be absent (not an empty array)
    expect(result.receipt.delegation_receipts).toBeUndefined();
    const valid = await verifyExecutionReceipt(result.receipt, keypair.publicKey);
    expect(valid).toBe(true);
  });

  it("includes delegation receipts from MCP adapters", async () => {
    const provider = createMockProvider("delegated work");
    const runtime = new MotebitRuntime(
      { motebitId: "test-mote", tickRateHz: 0 },
      createAdapters(provider),
    );

    // Inject a mock MCP adapter with delegation receipts
    const mockDelegationReceipt = {
      task_id: "sub-task-1",
      motebit_id: "remote-mote",
      device_id: "remote-dev",
      submitted_at: 1700000000000,
      completed_at: 1700000060000,
      status: "completed" as const,
      result: "subtask done",
      tools_used: ["tool_a"],
      memories_formed: 1,
      prompt_hash: "a".repeat(64),
      result_hash: "b".repeat(64),
      signature: "delegate-sig",
    };

    const mockAdapter = {
      disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getAndResetDelegationReceipts: vi.fn().mockReturnValue([mockDelegationReceipt]),
    };

    // Access private mcpAdapters array
    (runtime as unknown as { mcpAdapters: unknown[] }).mcpAdapters = [mockAdapter];

    const keypair = await generateKeypair();
    const task: AgentTask = {
      task_id: "task-005",
      motebit_id: "test-mote",
      prompt: "delegate to sub-agent",
      submitted_at: Date.now(),
      status: AgentTaskStatus.Claimed,
    };

    const result = await getTaskResult(
      runtime.handleAgentTask(task, keypair.privateKey, "device-005"),
    );

    expect(result.receipt.delegation_receipts).toHaveLength(1);
    expect(result.receipt.delegation_receipts![0]!.task_id).toBe("sub-task-1");
    expect(result.receipt.delegation_receipts![0]!.motebit_id).toBe("remote-mote");

    // Receipt with delegation_receipts should still verify
    const valid = await verifyExecutionReceipt(result.receipt, keypair.publicKey);
    expect(valid).toBe(true);
  });
});
