import { describe, it, expect, vi } from "vitest";
import {
  listMemories,
  listMemoryEdges,
  formMemoryDirect,
  deleteMemory,
  listDeletionCertificates,
  pinMemory,
  getDecayedConfidence,
} from "../memory-commands";

// Mock the embedText helper so tests don't hit ONNX
vi.mock("@motebit/memory-graph", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    embedText: vi.fn(async (_text: string) => new Float32Array([0.1, 0.2, 0.3])),
  };
});

// Minimal in-process runtime stub — matches only what memory-commands touches.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(overrides: Record<string, unknown> = {}): any {
  return {
    memory: {
      exportAll: vi.fn(async () => ({ nodes: [], edges: [] })),
      formMemory: vi.fn(async (input: unknown, _embedding: unknown) => ({
        ...(input as Record<string, unknown>),
        node_id: "n1",
        created_at: Date.now(),
      })),
      pinMemory: vi.fn(async () => {}),
      deleteMemory: vi.fn(async () => {}),
    },
    privacy: {
      deleteMemory: vi.fn(async () => ({
        cert_id: "c1",
        tombstone_hash: "h",
        signature: "s",
      })),
    },
    auditLog: {
      query: vi.fn(async () => []),
    },
    ...overrides,
  };
}

describe("memory-commands.listMemories", () => {
  it("returns [] when runtime is null", async () => {
    const result = await listMemories(null);
    expect(result).toEqual([]);
  });

  it("filters tombstoned + expired memories, sorts newest first", async () => {
    const now = Date.now();
    const runtime = makeRuntime({
      memory: {
        exportAll: vi.fn(async () => ({
          nodes: [
            { node_id: "a", content: "old", created_at: 1, tombstoned: false },
            { node_id: "b", content: "new", created_at: 10, tombstoned: false },
            { node_id: "c", content: "tombstoned", created_at: 5, tombstoned: true },
            {
              node_id: "d",
              content: "expired",
              created_at: 3,
              tombstoned: false,
              valid_until: now - 1000,
            },
          ],
          edges: [],
        })),
      },
    });
    const result = await listMemories(runtime);
    expect(result.map((n) => n.node_id)).toEqual(["b", "a"]);
  });

  it("returns [] when exportAll throws", async () => {
    const runtime = makeRuntime({
      memory: {
        exportAll: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    const result = await listMemories(runtime);
    expect(result).toEqual([]);
  });
});

describe("memory-commands.listMemoryEdges", () => {
  it("returns [] when runtime is null", async () => {
    expect(await listMemoryEdges(null)).toEqual([]);
  });

  it("returns edges from exportAll", async () => {
    const runtime = makeRuntime({
      memory: {
        exportAll: vi.fn(async () => ({
          nodes: [],
          edges: [{ edge_id: "e1", from: "a", to: "b", kind: "relates" }],
        })),
      },
    });
    const result = await listMemoryEdges(runtime);
    expect(result).toHaveLength(1);
  });

  it("returns [] on error", async () => {
    const runtime = makeRuntime({
      memory: {
        exportAll: vi.fn(async () => {
          throw new Error();
        }),
      },
    });
    expect(await listMemoryEdges(runtime)).toEqual([]);
  });
});

describe("memory-commands.formMemoryDirect", () => {
  it("returns null if runtime is null", async () => {
    expect(await formMemoryDirect(null, "content", 0.5)).toBeNull();
  });

  it("calls embedText + formMemory", async () => {
    const runtime = makeRuntime();
    await formMemoryDirect(runtime, "hello", 0.8);
    expect(runtime.memory.formMemory).toHaveBeenCalledOnce();
    const input = runtime.memory.formMemory.mock.calls[0][0];
    expect(input.content).toBe("hello");
    expect(input.confidence).toBe(0.8);
  });
});

describe("memory-commands.deleteMemory", () => {
  it("returns null if runtime is null", async () => {
    expect(await deleteMemory(null, "n")).toBeNull();
  });

  it("prefers the privacy layer", async () => {
    const runtime = makeRuntime();
    const result = await deleteMemory(runtime, "n1");
    expect(runtime.privacy.deleteMemory).toHaveBeenCalledWith("n1", "user_request");
    expect(result).toMatchObject({ cert_id: "c1" });
  });

  it("propagates privacy-layer failure rather than silently bypassing", async () => {
    // Pre-fix the desktop helper fell back to `runtime.memory.deleteMemory`
    // when the privacy layer threw, producing an unsigned, unaudited
    // erase. That bypass contradicted retention-policy.md decision 5
    // (every user_request requires a subject_signature), so the
    // fallback was removed: signing failure surfaces to the user as
    // "delete failed, retry" rather than producing a privacy-quiet
    // erasure. See `scripts/check-deletion-routes-through-privacy.ts`.
    const runtime = makeRuntime({
      privacy: {
        deleteMemory: vi.fn(async () => {
          throw new Error("no privacy layer");
        }),
      },
    });
    await expect(deleteMemory(runtime, "n1")).rejects.toThrow(/no privacy layer/);
    expect(runtime.memory.deleteMemory).not.toHaveBeenCalled();
  });
});

describe("memory-commands.listDeletionCertificates", () => {
  it("returns [] when runtime is null", async () => {
    expect(await listDeletionCertificates(null, "m")).toEqual([]);
  });

  it("projects delete_memory audit entries", async () => {
    const runtime = makeRuntime({
      auditLog: {
        query: vi.fn(async () => [
          {
            action: "delete_memory",
            audit_id: "a1",
            timestamp: 123,
            target_id: "n1",
            details: { tombstone_hash: "h1", deleted_by: "user" },
          },
          {
            action: "other_action",
            audit_id: "a2",
            timestamp: 456,
            target_id: "n2",
            details: {},
          },
        ]),
      },
    });
    const result = await listDeletionCertificates(runtime, "m");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      auditId: "a1",
      tombstoneHash: "h1",
      deletedBy: "user",
    });
  });

  it("handles missing details gracefully", async () => {
    const runtime = makeRuntime({
      auditLog: {
        query: vi.fn(async () => [
          {
            action: "delete_memory",
            audit_id: "a1",
            timestamp: 123,
            target_id: "n1",
            details: {},
          },
        ]),
      },
    });
    const result = await listDeletionCertificates(runtime, "m");
    expect(result[0]?.tombstoneHash).toBe("");
    expect(result[0]?.deletedBy).toBe("");
  });

  it("returns [] on audit query error", async () => {
    const runtime = makeRuntime({
      auditLog: {
        query: vi.fn(async () => {
          throw new Error();
        }),
      },
    });
    expect(await listDeletionCertificates(runtime, "m")).toEqual([]);
  });
});

describe("memory-commands.pinMemory", () => {
  it("no-ops when runtime is null", async () => {
    await expect(pinMemory(null, "n", true)).resolves.toBeUndefined();
  });

  it("forwards to runtime.memory.pinMemory", async () => {
    const runtime = makeRuntime();
    await pinMemory(runtime, "node-42", true);
    expect(runtime.memory.pinMemory).toHaveBeenCalledWith("node-42", true);
  });
});

describe("memory-commands.getDecayedConfidence", () => {
  it("computes a valid decayed confidence value", () => {
    const node = {
      confidence: 1.0,
      half_life: 7 * 24 * 3600 * 1000,
      created_at: Date.now() - 24 * 3600 * 1000, // 1 day old
    } as Parameters<typeof getDecayedConfidence>[0];
    const decayed = getDecayedConfidence(node);
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThanOrEqual(1.0);
  });
});
