/**
 * #943 round 7 — a config `motebit: true` MCP server connected by the CLI
 * REPL still renders as a DELEGATION.
 *
 * The REPL now owns each config connection (`connectConfigMcpServers`), so
 * the runtime's `init()` never sees those adapters — and the tool→server
 * mapping that turns a `mote__motebit_task` call into `delegation_start` /
 * `delegation_complete` (the delegating line, the creature's delegating
 * state, the settled-hire ledger) was lost. The wiring now registers the
 * mapping (`registerMotebitToolServer`), and `/mcp remove` clears it.
 *
 * Tamper: drop the `registerMotebitToolServer` call from
 * `connectConfigMcpServers` — the delegation chunks disappear.
 */
import { describe, it, expect, vi } from "vitest";
import type { AIResponse, ContextPack, ToolDefinition, ToolResult } from "@motebit/sdk";
import { RiskLevel } from "@motebit/sdk";

const MOTE_TOOL: ToolDefinition = {
  name: "mote__motebit_task",
  mode: "api",
  description: "Submit a task to the mote motebit",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R0_READ },
};

vi.mock("@motebit/mcp-client", async () => {
  const actual = await vi.importActual<typeof import("@motebit/mcp-client")>("@motebit/mcp-client");
  return {
    ...actual,
    connectMcpServers: vi.fn(async () => [
      {
        serverName: "mote",
        isMotebit: true,
        getTools: () => [MOTE_TOOL],
        registerInto: (reg: {
          has(n: string): boolean;
          register(d: ToolDefinition, h: () => Promise<ToolResult>): void;
        }) => {
          if (!reg.has(MOTE_TOOL.name)) {
            reg.register(MOTE_TOOL, async () => ({ ok: true, data: "sub-task done" }));
          }
        },
        disconnect: async () => {},
      },
    ]),
  };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import type { StreamChunk } from "@motebit/runtime";
import type { StreamingProvider } from "@motebit/ai-core";
import {
  connectConfigMcpServers,
  disconnectMcpServer,
  runtimeMcpServersForRepl,
} from "../mcp-config-wiring.js";

function callingProvider(): StreamingProvider {
  const gen = (ctx: ContextPack): AIResponse => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (!history.includes(MOTE_TOOL.name)) {
      return {
        text: "",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "c1", name: MOTE_TOOL.name, args: {} }],
      };
    }
    return { text: "done", confidence: 0.8, memory_candidates: [], state_updates: {} };
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: ContextPack) => gen(ctx)),
    estimateConfidence: vi.fn(async () => 0.8),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      const r = gen(ctx);
      if (r.text) yield { type: "text" as const, text: r.text };
      yield { type: "done" as const, response: r };
    },
  };
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("#943 — the REPL's config motebit servers still delegate visibly", () => {
  it("an owner turn calling mote__motebit_task emits delegation_start + delegation_complete; /mcp remove clears the mapping", async () => {
    const servers = [{ name: "mote", transport: "http" as const, url: "http://x", motebit: true }];
    const runtime = new MotebitRuntime(
      { motebitId: "owner-mote", tickRateHz: 0, mcpServers: runtimeMcpServersForRepl(servers) },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: callingProvider() },
    );
    const { adapters } = await connectConfigMcpServers(runtime, servers);
    await runtime.init();

    const chunks = await collect(runtime.sendMessageStreaming("ask mote"));
    const types = chunks.map((c) => c.type);
    expect(types).toContain("delegation_start");
    expect(types).toContain("delegation_complete");
    const start = chunks.find((c) => c.type === "delegation_start") as { server?: string };
    expect(start.server).toBe("mote");

    await disconnectMcpServer(runtime, adapters, "mote");
    const mapping = (runtime as unknown as { motebitToolServers: Map<string, string> })
      .motebitToolServers;
    expect(mapping.has(MOTE_TOOL.name)).toBe(false);
  });
});
