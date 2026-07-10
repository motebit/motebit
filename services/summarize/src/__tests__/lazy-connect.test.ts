/**
 * Lazy-connect contract for the summarize handler.
 *
 * The delegating service must register at boot and connect to web-search
 * on the FIRST task, not eagerly at boot — an unreachable dependency
 * fails the task, never crashes the service (the staging flap this fixes).
 */
import { describe, it, expect, vi } from "vitest";
import type { McpClientAdapter } from "@motebit/mcp-client";
import { createSummarizeSearchHandler } from "../tool.js";

function fakeAdapter(executeResult: { ok: boolean; data?: unknown; error?: string }) {
  return {
    serverName: "web-search",
    executeTool: vi.fn(async () => executeResult),
  } as unknown as McpClientAdapter;
}

describe("summarize handler — lazy connect", () => {
  it("calls ensureConnected before delegating, exactly once per invocation", async () => {
    const ensure = vi.fn(async () => {});
    const adapter = fakeAdapter({ ok: true, data: "[]" });
    const handler = createSummarizeSearchHandler(adapter, ensure);

    const res = await handler({ query: "hello" });
    expect(res.ok).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
    // ensure runs before the delegation
    expect(ensure.mock.invocationCallOrder[0]!).toBeLessThan(
      (adapter.executeTool as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
  });

  it("a failed connect fails the TASK (ok:false), never throws — the service survives", async () => {
    const ensure = vi.fn(async () => {
      throw new Error("web-search cold");
    });
    const adapter = fakeAdapter({ ok: true, data: "[]" });
    const handler = createSummarizeSearchHandler(adapter, ensure);

    const res = await handler({ query: "hello" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("web-search unreachable");
    // The dependency was never reached — the connect gate short-circuited.
    expect(adapter.executeTool).not.toHaveBeenCalled();
  });

  it("without an ensureConnected fn, the handler still works (backward compatible)", async () => {
    const adapter = fakeAdapter({ ok: true, data: "[]" });
    const handler = createSummarizeSearchHandler(adapter);
    const res = await handler({ query: "hello" });
    expect(res.ok).toBe(true);
  });
});
