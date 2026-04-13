import { describe, it, expect } from "vitest";
import { scoreResultQuality, QUALITY_FAILURE_THRESHOLD } from "../quality.js";
import type { ExecutionReceipt } from "@motebit/protocol";
import type { MotebitId, DeviceId } from "@motebit/protocol";

function makeReceipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    task_id: "task-1",
    motebit_id: "agent-1" as unknown as MotebitId,
    device_id: "device-1" as unknown as DeviceId,
    submitted_at: Date.now() - 2000,
    completed_at: Date.now(),
    status: "completed",
    result:
      "Here are the search results for your query. Found 3 relevant pages with detailed information about the topic.",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "abc",
    result_hash: "def",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
    relay_task_id: "task-1",
    ...overrides,
  };
}

describe("scoreResultQuality", () => {
  it("scores a good result highly", () => {
    const receipt = makeReceipt({
      result:
        "Here are 5 search results about TypeScript. 1. typescriptlang.org - The official TypeScript website with documentation and tutorials. 2. github.com/microsoft/TypeScript - Source code repository. 3. devblogs.microsoft.com - Latest TypeScript release notes and announcements. 4. stackoverflow.com - Community Q&A about TypeScript. 5. wikipedia.org - TypeScript overview and history.",
      tools_used: ["web_search", "read_url"],
    });
    const score = scoreResultQuality(receipt);
    expect(score).toBeGreaterThan(0.5);
  });

  it("scores an empty result near zero", () => {
    const receipt = makeReceipt({ result: "", tools_used: [] });
    const score = scoreResultQuality(receipt);
    expect(score).toBeLessThan(QUALITY_FAILURE_THRESHOLD);
  });

  it("scores 'no results found' as low quality", () => {
    const receipt = makeReceipt({ result: "No results found.", tools_used: ["web_search"] });
    const score = scoreResultQuality(receipt);
    expect(score).toBeLessThan(0.4);
  });

  it("scores a trivial one-word result as low", () => {
    const receipt = makeReceipt({ result: "yes", tools_used: [] });
    const score = scoreResultQuality(receipt);
    expect(score).toBeLessThan(0.15);
  });

  it("rewards tool usage", () => {
    const withTools = scoreResultQuality(
      makeReceipt({
        result: "Result text here for testing.",
        tools_used: ["web_search", "read_url"],
      }),
    );
    const withoutTools = scoreResultQuality(
      makeReceipt({
        result: "Result text here for testing.",
        tools_used: [],
      }),
    );
    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it("returns value in [0, 1] range", () => {
    // Minimum: empty everything
    const min = scoreResultQuality(
      makeReceipt({
        result: "",
        tools_used: [],
        submitted_at: Date.now(),
        completed_at: Date.now(),
      }),
    );
    expect(min).toBeGreaterThanOrEqual(0);
    expect(min).toBeLessThanOrEqual(1);

    // Maximum: long result, many tools, reasonable latency
    const max = scoreResultQuality(
      makeReceipt({
        result: "x".repeat(1000),
        tools_used: ["a", "b", "c", "d"],
        submitted_at: Date.now() - 10000,
        completed_at: Date.now(),
      }),
    );
    expect(max).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
  });

  it("handles missing timestamps gracefully", () => {
    const receipt = makeReceipt({ submitted_at: 0, completed_at: 0 });
    const score = scoreResultQuality(receipt);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("QUALITY_FAILURE_THRESHOLD", () => {
  it("is 0.2", () => {
    expect(QUALITY_FAILURE_THRESHOLD).toBe(0.2);
  });
});
