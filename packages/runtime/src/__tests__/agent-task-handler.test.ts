import { vi, describe, it, expect, beforeEach } from "vitest";
import { generateKeypair, verifyExecutionReceipt } from "@motebit/encryption";
import { handleAgentTask } from "../agent-task-handler.js";
import type { AgentTaskHandlerDeps, SavedConversationContext } from "../agent-task-handler.js";
import type { StreamChunk } from "../index.js";
import type { AgentTask } from "@motebit/sdk";
import { AgentTaskStatus } from "@motebit/sdk";

// === Helpers ===

async function* mockStream(text: string): AsyncGenerator<StreamChunk> {
  yield { type: "text", text };
  yield {
    type: "result",
    result: {
      response: text,
      memoriesFormed: [],
      memoriesRetrieved: [],
      stateAfter: {} as any,
      cues: {} as any,
      iterations: 1,
      toolCallsSucceeded: 0,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    },
  };
}

async function* mockStreamWithTools(text: string, tools: string[]): AsyncGenerator<StreamChunk> {
  for (const tool of tools) {
    yield { type: "tool_status", name: tool, status: "calling" };
    yield { type: "tool_status", name: tool, status: "done" };
  }
  yield { type: "text", text };
  yield {
    type: "result",
    result: {
      response: text,
      memoriesFormed: [],
      memoriesRetrieved: [],
      stateAfter: {} as any,
      cues: {} as any,
      iterations: 1,
      toolCallsSucceeded: tools.length,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    },
  };
}

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

async function getTaskResult(
  gen: AsyncGenerator<StreamChunk>,
): Promise<StreamChunk & { type: "task_result" }> {
  for await (const chunk of gen) {
    if (chunk.type === "task_result") return chunk;
  }
  throw new Error("No task_result chunk found");
}

// === Mocks ===

function createMockDeps(overrides?: Partial<AgentTaskHandlerDeps>): AgentTaskHandlerDeps {
  const savedCtx: SavedConversationContext = { history: [], id: null };

  return {
    motebitId: "motebit-test-id",
    events: {
      appendWithClock: vi.fn().mockResolvedValue(1),
      append: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      getLatestClock: vi.fn().mockResolvedValue(0),
      tombstone: vi.fn(),
    } as any,
    agentTrustStore: null,
    agentGraph: { addReceiptEdges: vi.fn().mockResolvedValue(undefined) } as any,
    latencyStatsStore: null,
    logger: { warn: vi.fn() },
    sendMessageStreaming: vi.fn().mockReturnValue(mockStream("Task completed successfully")),
    saveConversationContext: vi.fn().mockReturnValue(savedCtx),
    clearConversationForTask: vi.fn(),
    restoreConversationContext: vi.fn(),
    getMcpAdapters: vi.fn().mockReturnValue([]),
    getAndResetInteractiveDelegationReceipts: vi.fn().mockReturnValue([]),
    bumpTrustFromReceipt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockTask(overrides?: Partial<AgentTask>): AgentTask {
  return {
    task_id: "task-abc-123",
    motebit_id: "motebit-test-id",
    prompt: "Search for recent news about AI",
    submitted_at: Date.now() - 1000,
    status: AgentTaskStatus.Claimed,
    capabilities: ["web_search"],
    ...overrides,
  } as AgentTask;
}

// === Tests ===

describe("handleAgentTask (direct)", () => {
  let keypair: { publicKey: Uint8Array; privateKey: Uint8Array };

  beforeEach(async () => {
    keypair = await generateKeypair();
  });

  it("produces a signed receipt with correct fields", async () => {
    const deps = createMockDeps();
    const task = createMockTask();

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    const receipt = result.receipt;
    expect(receipt.task_id).toBe("task-abc-123");
    expect(receipt.motebit_id).toBe("motebit-test-id");
    expect(receipt.device_id).toBe("device-001");
    expect(receipt.status).toBe("completed");
    expect(receipt.relay_task_id).toBe("task-abc-123");
    expect(receipt.signature).toBeDefined();
    expect(receipt.signature.length).toBeGreaterThan(0);
  });

  it("receipt signature is verifiable with the public key", async () => {
    const deps = createMockDeps();
    const task = createMockTask();

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    const verified = await verifyExecutionReceipt(result.receipt, keypair.publicKey);
    expect(verified).toBe(true);
  });

  it("saves conversation context before and restores after task", async () => {
    const deps = createMockDeps();
    const task = createMockTask();

    const chunks = await collectChunks(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    expect(deps.saveConversationContext).toHaveBeenCalledOnce();
    expect(deps.clearConversationForTask).toHaveBeenCalledOnce();
    expect(deps.restoreConversationContext).toHaveBeenCalledOnce();

    // Save is called before clear
    const saveOrder = (deps.saveConversationContext as any).mock.invocationCallOrder[0];
    const clearOrder = (deps.clearConversationForTask as any).mock.invocationCallOrder[0];
    const restoreOrder = (deps.restoreConversationContext as any).mock.invocationCallOrder[0];
    expect(saveOrder).toBeLessThan(clearOrder);
    expect(clearOrder).toBeLessThan(restoreOrder);

    // Verify task_result is in the output
    expect(chunks.some((c) => c.type === "task_result")).toBe(true);
  });

  it("status is 'failed' when sendMessageStreaming throws", async () => {
    const deps = createMockDeps({
      sendMessageStreaming: vi.fn().mockImplementation(function () {
        return (async function* (): AsyncGenerator<StreamChunk> {
          throw new Error("Provider unavailable");
        })();
      }),
    });
    const task = createMockTask();

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.result).toContain("Provider unavailable");
  });

  it("status is 'completed' on success", async () => {
    const deps = createMockDeps();
    const task = createMockTask();

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    expect(result.receipt.status).toBe("completed");
  });

  it("tracks tools used from tool_status chunks", async () => {
    const deps = createMockDeps({
      sendMessageStreaming: vi
        .fn()
        .mockReturnValue(mockStreamWithTools("Done", ["web_search", "read_url", "web_search"])),
    });
    const task = createMockTask();

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    // web_search appears twice but should be deduplicated
    expect(result.receipt.tools_used).toEqual(["web_search", "read_url"]);
  });

  it("relay_task_id matches task.task_id (economic binding)", async () => {
    const deps = createMockDeps();
    const task = createMockTask({ task_id: "relay-task-xyz-789" });

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    expect(result.receipt.relay_task_id).toBe("relay-task-xyz-789");
    expect(result.receipt.task_id).toBe(result.receipt.relay_task_id);
  });

  it("receipt includes prompt_hash and result_hash as 64-char hex strings", async () => {
    const deps = createMockDeps();
    const task = createMockTask();

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    const receipt = result.receipt;
    expect(receipt.prompt_hash).toBeDefined();
    expect(receipt.result_hash).toBeDefined();
    expect(receipt.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.result_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("restores conversation context even when streaming fails", async () => {
    const deps = createMockDeps({
      sendMessageStreaming: vi.fn().mockImplementation(function () {
        return (async function* (): AsyncGenerator<StreamChunk> {
          throw new Error("Crash");
        })();
      }),
    });
    const task = createMockTask();

    await collectChunks(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    expect(deps.restoreConversationContext).toHaveBeenCalledOnce();
  });
});
