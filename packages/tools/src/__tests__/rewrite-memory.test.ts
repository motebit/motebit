/**
 * `rewrite_memory` tool — agent self-healing correction path.
 *
 * Pins:
 *   1. Missing arguments short-circuit with a usable error (the agent
 *      must get a clear signal, not a vague failure).
 *   2. The handler disambiguates short-id ↔ full-uuid via the injected
 *      `resolveNodeId` dep — tool logic stays storage-agnostic.
 *   3. Ambiguous prefix is a recoverable error with a helpful hint.
 *   4. Not-found is a recoverable error (the memory may have been
 *      superseded already — a retry-with-fuller-context is the
 *      sensible follow-up, not a crash).
 *   5. Success carries enough info back that the agent can confirm
 *      the rewrite in its reply without a follow-up tool call.
 */
import { describe, expect, it, vi } from "vitest";
import {
  rewriteMemoryDefinition,
  createRewriteMemoryHandler,
  type RewriteMemoryDeps,
} from "../builtins/rewrite-memory.js";

function makeDeps(overrides: Partial<RewriteMemoryDeps> = {}): RewriteMemoryDeps {
  return {
    resolveNodeId: vi.fn(async () => ({
      kind: "ok" as const,
      nodeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    })),
    supersedeMemory: vi.fn(async () => "11111111-2222-3333-4444-555555555555"),
    ...overrides,
  };
}

describe("rewrite_memory tool definition", () => {
  it("declares the three required args with usable descriptions", () => {
    expect(rewriteMemoryDefinition.name).toBe("rewrite_memory");
    expect(rewriteMemoryDefinition.inputSchema.required).toEqual([
      "node_id",
      "new_content",
      "reason",
    ]);
  });
});

describe("rewrite_memory handler — happy path", () => {
  it("resolves the node id and supersedes with the new content", async () => {
    const deps = makeDeps();
    const handler = createRewriteMemoryHandler(deps);

    const result = await handler({
      node_id: "aaaaaaaa",
      new_content: "User actually lives in SF, not NYC.",
      reason: "user correction",
    });

    expect(result.ok).toBe(true);
    expect(deps.resolveNodeId).toHaveBeenCalledWith("aaaaaaaa");
    expect(deps.supersedeMemory).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "User actually lives in SF, not NYC.",
      "user correction",
    );
    expect(result.data).toMatch(/Memory rewritten/);
    expect(result.data).toMatch(/aaaaaaaa/);
    expect(result.data).toMatch(/11111111/);
  });

  it("trims whitespace from the node id before resolution", async () => {
    const deps = makeDeps();
    const handler = createRewriteMemoryHandler(deps);

    await handler({
      node_id: "  aaaaaaaa  ",
      new_content: "new",
      reason: "why",
    });

    expect(deps.resolveNodeId).toHaveBeenCalledWith("aaaaaaaa");
  });
});

describe("rewrite_memory handler — recoverable errors", () => {
  it("returns a usable error when node_id is missing", async () => {
    const deps = makeDeps();
    const handler = createRewriteMemoryHandler(deps);

    const result = await handler({ new_content: "x", reason: "y" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/node_id/);
    expect(deps.resolveNodeId).not.toHaveBeenCalled();
  });

  it("returns a usable error when new_content is missing", async () => {
    const handler = createRewriteMemoryHandler(makeDeps());
    const result = await handler({ node_id: "abc", reason: "y" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/new_content/);
  });

  it("returns a usable error when reason is missing", async () => {
    const handler = createRewriteMemoryHandler(makeDeps());
    const result = await handler({ node_id: "abc", new_content: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reason/);
  });

  it("surfaces not-found with a useful hint, not a crash", async () => {
    const deps = makeDeps({
      resolveNodeId: vi.fn(async () => ({ kind: "not_found" as const })),
    });
    const handler = createRewriteMemoryHandler(deps);

    const result = await handler({
      node_id: "zzzzzzzz",
      new_content: "anything",
      reason: "testing",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No live memory/);
    expect(result.error).toMatch(/zzzzzzzz/);
  });

  it("surfaces ambiguous-prefix with the candidate matches", async () => {
    const deps = makeDeps({
      resolveNodeId: vi.fn(async () => ({
        kind: "ambiguous" as const,
        matches: ["aaaaaaaa-1111-2222-3333-444444444444", "aaaaaaaa-5555-6666-7777-888888888888"],
      })),
    });
    const handler = createRewriteMemoryHandler(deps);

    const result = await handler({
      node_id: "aaaaaaaa",
      new_content: "anything",
      reason: "testing",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/multiple memories/);
    expect(result.error).toMatch(/longer prefix or the full UUID/);
  });

  it("returns a recoverable error on supersede failure — no crash", async () => {
    const deps = makeDeps({
      supersedeMemory: vi.fn(async () => {
        throw new Error("storage offline");
      }),
    });
    const handler = createRewriteMemoryHandler(deps);

    const result = await handler({
      node_id: "aaaaaaaa",
      new_content: "x",
      reason: "y",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rewrite_memory failed: storage offline/);
  });
});
