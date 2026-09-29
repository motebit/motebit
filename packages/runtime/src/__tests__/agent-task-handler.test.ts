import { vi, describe, it, expect, beforeEach } from "vitest";
import { generateKeypair, verifyExecutionReceipt } from "@motebit/encryption";
import { handleAgentTask } from "../agent-task-handler.js";
import type { AgentTaskHandlerDeps } from "../agent-task-handler.js";
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

/**
 * A stream that attempts work but is hard-denied by governance: the loop made
 * `succeeded` successful tool calls and `denied` policy-refused ones. Mirrors
 * what `runTurnStreaming` emits when PolicyGate.validate returns
 * `allowed: false` (deny_above / denylist / scope / budget).
 */
async function* mockStreamGoverned(
  text: string,
  succeeded: number,
  denied: number,
): AsyncGenerator<StreamChunk> {
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
      toolCallsSucceeded: succeeded,
      toolCallsBlocked: denied,
      toolCallsDenied: denied,
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

  it("#885: a payment_notice while serving another principal's task is logged loudly", async () => {
    async function* withNotice(): AsyncGenerator<StreamChunk> {
      yield {
        type: "payment_notice",
        notice: "This hire's wallet ALSO sent another payment (tx sigA, landed)",
        extra_payments: [{ tx_hash: "sigA", status: "landed" }],
      };
      yield* mockStream("done");
    }
    const warn = vi.fn();
    const deps = createMockDeps({
      logger: { warn },
      sendMessageStreaming: vi.fn().mockReturnValue(withNotice()),
    });
    await getTaskResult(
      handleAgentTask(deps, createMockTask(), keypair.privateKey, "device-001", keypair.publicKey),
    );
    expect(warn).toHaveBeenCalledWith(
      "delegation.payment_notice",
      expect.objectContaining({
        task_id: "task-abc-123",
        extra_payments: [{ tx_hash: "sigA", status: "landed" }],
      }),
    );
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

  it("never swaps the owner's conversation out for the task (#943 round 10)", async () => {
    // The task's turn is foreign; its isolation is `forTurn(FOREIGN)`. The
    // handler's deps carry no save / clear / restore of the owner's history.
    const deps = createMockDeps() as unknown as Record<string, unknown>;
    const task = createMockTask();
    const chunks = await collectChunks(
      handleAgentTask(
        deps as unknown as AgentTaskHandlerDeps,
        task,
        keypair.privateKey,
        "device-001",
        keypair.publicKey,
      ),
    );
    for (const k of [
      "saveConversationContext",
      "clearConversationForTask",
      "restoreConversationContext",
    ]) {
      expect(k in deps).toBe(false);
    }
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

  // === Delegation policy refusal path ===

  it("mints an agent-signed status:'denied' receipt when governance refused every action", async () => {
    const deps = createMockDeps({
      sendMessageStreaming: vi
        .fn()
        .mockReturnValue(mockStreamGoverned("I'm not permitted to do that.", 0, 1)),
    });
    const task = createMockTask();

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    // The agent refuses itself — signed by its OWN key, verifiable offline.
    expect(result.receipt.status).toBe("denied");
    expect(result.receipt.result).toContain("refused by governance");
    expect(await verifyExecutionReceipt(result.receipt, keypair.publicKey)).toBe(true);
  });

  it("logs the denial as AgentTaskDenied", async () => {
    const deps = createMockDeps({
      sendMessageStreaming: vi.fn().mockReturnValue(mockStreamGoverned("nope", 0, 2)),
    });
    const task = createMockTask();

    await collectChunks(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    const calls = (deps.events.appendWithClock as any).mock.calls as Array<
      [{ event_type: string }]
    >;
    expect(calls.some(([e]) => e.event_type === "agent_task_denied")).toBe(true);
  });

  it("does NOT deny when at least one action succeeded (partial work is completion, not refusal)", async () => {
    const deps = createMockDeps({
      sendMessageStreaming: vi.fn().mockReturnValue(mockStreamGoverned("Did part of it.", 1, 1)),
    });
    const task = createMockTask();

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    expect(result.receipt.status).toBe("completed");
  });

  it("does NOT deny a zero-action task (nothing was refused)", async () => {
    const deps = createMockDeps({
      sendMessageStreaming: vi.fn().mockReturnValue(mockStreamGoverned("Here's the answer.", 0, 0)),
    });
    const task = createMockTask();

    const result = await getTaskResult(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    expect(result.receipt.status).toBe("completed");
  });

  it("a thrown provider error stays 'failed', never reclassified as 'denied'", async () => {
    // A crash is a failure; a policy block is a denial. The two must not be
    // confused on the signed record — the downgrade only fires from 'completed'.
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
  });

  it("a crashing stream still yields a signed (failed) task result", async () => {
    const deps = createMockDeps({
      sendMessageStreaming: vi.fn().mockImplementation(function () {
        return (async function* (): AsyncGenerator<StreamChunk> {
          throw new Error("Crash");
        })();
      }),
    });
    const task = createMockTask();

    const chunks = await collectChunks(
      handleAgentTask(deps, task, keypair.privateKey, "device-001", keypair.publicKey),
    );

    expect(chunks.some((c) => c.type === "task_result")).toBe(true);
  });
});
