import { describe, it, expect, vi, beforeEach } from "vitest";

// Event log shared across mocks — tests assert on the ORDER of status
// transitions relative to rendered output, the register the user feels.
const events: Array<[string, string]> = [];

const { startStatus } = vi.hoisted(() => {
  const startStatus = (verb: string, subject?: string) => {
    events.push(["status", subject ? `${verb} ${subject}` : verb]);
    let stopped = false;
    return {
      step: (text: string) => events.push(["step", text]),
      note: () => {},
      stop: () => {
        if (stopped) return 0;
        stopped = true;
        events.push(["stop", subject ? `${verb} ${subject}` : verb]);
        return 1000;
      },
    };
  };
  return { startStatus };
});

vi.mock("../statusline.js", () => ({ startStatus }));
vi.mock("../terminal.js", () => ({
  writeOutput: (s: string) => events.push(["out", s]),
  writeLine: (s: string) => events.push(["line", s]),
  askQuestion: async () => "n",
}));
vi.mock("../receipt.js", () => ({
  archiveReceipt: () => {},
  renderReceipt: async () => {},
}));

import { consumeStream } from "../stream.js";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";

async function* chunks(...list: Partial<StreamChunk>[]): AsyncGenerator<StreamChunk> {
  for (const c of list) yield c as StreamChunk;
}

const runtime = {} as MotebitRuntime;

/** The status-transition trace, ignoring rendered text/lines. */
function statusTrace(): string[] {
  return events.filter(([k]) => k === "status" || k === "stop").map(([k, v]) => `${k}:${v}`);
}

const resultChunk = {
  type: "result",
  result: {
    memoriesFormed: [],
    stateAfter: { attention: 0.5, confidence: 0.5, affect_valence: 0, curiosity: 0.5 },
    cues: [],
  },
} as unknown as StreamChunk;

describe("consumeStream — thinking-status row during model latency (#480)", () => {
  beforeEach(() => {
    events.length = 0;
  });

  it("shows thinking from stream start until the first text chunk", async () => {
    await consumeStream(chunks({ type: "text", text: "hello" }, resultChunk), runtime);
    const textIdx = events.findIndex(([k, v]) => k === "out" && v === "hello");
    const stopIdx = events.findIndex(([k, v]) => k === "stop" && v === "thinking");
    expect(events[0]).toEqual(["status", "thinking"]);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(textIdx);
  });

  it("restarts thinking after a tool finishes — the inter-act latency gap", async () => {
    await consumeStream(
      chunks(
        { type: "text", text: "let me look" },
        { type: "tool_status", name: "web_search", status: "calling" },
        { type: "tool_status", name: "web_search", status: "done" },
        { type: "text", text: "found it" },
        resultChunk,
      ),
      runtime,
    );
    expect(statusTrace()).toEqual([
      "status:thinking",
      "stop:thinking",
      "status:running web_search",
      "stop:running web_search",
      "status:thinking",
      "stop:thinking",
    ]);
  });

  it("delegation_start replaces thinking instead of being skipped by it", async () => {
    await consumeStream(
      chunks(
        { type: "delegation_start", tool: "research" } as unknown as StreamChunk,
        { type: "delegation_complete", tool: "research" } as unknown as StreamChunk,
        resultChunk,
      ),
      runtime,
    );
    expect(statusTrace()).toEqual([
      "status:thinking",
      "stop:thinking",
      "status:delegating research",
      "stop:delegating research",
      "status:thinking",
      "stop:thinking",
    ]);
    // The delegation done-line rendered (the guard did not mistake thinking
    // for an already-running delegation status)
    expect(events.some(([k, v]) => k === "line" && v.includes("research"))).toBe(true);
  });

  it("a stream ending in an approval request leaves no status running", async () => {
    // resolveApprovalVote yields nothing — the #457 backstop line renders.
    const rt = {
      motebitId: "m-1",
      resolveApprovalVote: () => chunks(),
    } as unknown as MotebitRuntime;
    await consumeStream(
      chunks({ type: "text", text: "I need approval" }, {
        type: "approval_request",
        tool_call_id: "t1",
        name: "delegate_to_agent",
        args: {},
      } as unknown as StreamChunk),
      rt,
    );
    const starts = events.filter(([k]) => k === "status").length;
    const stops = events.filter(([k]) => k === "stop").length;
    expect(starts).toBe(stops);
    // Every status started before the approval band was stopped before it —
    // no pulsing row above a waiting y/n prompt. (The resumed stream after
    // the "n" answer runs its own thinking cycle; that's the tail pair.)
    const bandIdx = events.findIndex(([k]) => k === "line");
    expect(bandIdx).toBeGreaterThan(-1);
    const before = events.slice(0, bandIdx);
    expect(before.filter(([k]) => k === "status").length).toBe(
      before.filter(([k]) => k === "stop").length,
    );
  });

  it("a stray tool done with no work status does not mint a done-line from thinking", async () => {
    await consumeStream(
      chunks({ type: "tool_status", name: "delegate_to_agent", status: "done" }, resultChunk),
      runtime,
    );
    expect(events.filter(([k, v]) => k === "line" && v.includes("done")).length).toBe(0);
  });

  it("result chunk stops thinking even when no text ever arrived", async () => {
    await consumeStream(chunks(resultChunk), runtime);
    const starts = events.filter(([k]) => k === "status").length;
    const stops = events.filter(([k]) => k === "stop").length;
    expect(starts).toBe(stops);
  });

  it("the result chunk renders no state-vector or body telemetry (#480)", async () => {
    await consumeStream(chunks({ type: "text", text: "done." }, resultChunk), runtime);
    const rendered = events
      .filter(([k]) => k === "out" || k === "line")
      .map(([, v]) => v)
      .join("");
    expect(rendered).not.toContain("[state:");
    expect(rendered).not.toContain("attention=");
    expect(rendered).not.toContain("[Body");
  });

  it("memories formed — the durable mutation — still render after the turn", async () => {
    const withMemories = {
      ...(resultChunk as unknown as { result: Record<string, unknown> }),
      result: {
        memoriesFormed: [{ content: "Daniel prefers calm software" }],
        stateAfter: { attention: 0.5, confidence: 0.5, affect_valence: 0, curiosity: 0.5 },
        cues: [],
      },
    } as unknown as StreamChunk;
    await consumeStream(chunks({ type: "text", text: "noted." }, withMemories), runtime);
    const rendered = events.map(([, v]) => v).join("");
    expect(rendered).toContain("[memories: Daniel prefers calm software]");
    expect(rendered).not.toContain("[state:");
  });

  it("a throwing stream still tears the thinking row down (finally path)", async () => {
    async function* boom(): AsyncGenerator<StreamChunk> {
      yield { type: "text", text: "so" } as StreamChunk;
      throw new Error("provider fell over");
    }
    await expect(consumeStream(boom(), runtime)).rejects.toThrow("provider fell over");
    const starts = events.filter(([k]) => k === "status").length;
    const stops = events.filter(([k]) => k === "stop").length;
    expect(starts).toBe(stops);
  });
});
