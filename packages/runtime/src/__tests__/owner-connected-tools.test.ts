/**
 * #943 — tools from servers the OWNER connected are `localOnly`.
 *
 * An MCP server the owner adds (settings / `/mcp add` → `registerExternalTools`,
 * or the runtime's `mcpServers` config → `connectMcpServers`) acts for the
 * owner against the owner's own data: filesystem, mail, Notion. Before this
 * fix those tools were registered without `localOnly`, so a stranger's
 * `motebit_query` / `motebit_task` could drive them, and the MCP server
 * re-served them. Now they are `localOnly` (fail closed): a foreign turn is
 * never offered one and a call naming one is refused; the owner's own turns
 * keep them.
 *
 * Tamper: drop `localOnly: true` from `registerOwnerConnectedTool` — the
 * foreign cases go red.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/mcp-client", async () => {
  const actual = await vi.importActual<typeof import("@motebit/mcp-client")>("@motebit/mcp-client");
  return {
    ...actual,
    // The runtime's `mcpServers` path: one fake server that exposes `mail__read_inbox`.
    connectMcpServers: vi.fn(
      async (
        _configs: unknown,
        registry: { has(n: string): boolean; register(d: unknown, h: unknown): void },
      ) => {
        if (!registry.has("mail__read_inbox")) {
          registry.register(
            {
              name: "mail__read_inbox",
              description: "read the owner's inbox",
              inputSchema: { type: "object", properties: {} },
            },
            async () => ({ ok: true, data: "sent" }),
          );
        }
        return [{ disconnect: async () => {}, serverName: "mail" }];
      },
    ),
  };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ToolRegistry } from "@motebit/sdk";

function recordingProvider(contexts: ContextPack[]): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.9,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async () => response),
    estimateConfidence: vi.fn(async () => 0.9),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      contexts.push(ctx);
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  };
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<void> {
  for await (const _c of gen) {
    /* consume */
  }
}

function fsRegistry(): ToolRegistry {
  return {
    list: () => [
      {
        name: "fs__read",
        description: "read the owner's files",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    execute: async () => ({ ok: true, data: "OWNER-FILE" }),
    register: () => {},
  } as unknown as ToolRegistry;
}

const toolNames = (ctx: ContextPack | undefined): string[] => (ctx?.tools ?? []).map((t) => t.name);

describe("#943 — owner-connected external tools are never a foreign turn's", () => {
  it("registerExternalTools: offered to the owner's turn, never to a foreign turn; refused if named", async () => {
    const contexts: ContextPack[] = [];
    const runtime = new MotebitRuntime(
      { motebitId: "owner-mote", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: recordingProvider(contexts),
      },
    );
    runtime.registerExternalTools("mcp:fs", fsRegistry());
    expect(runtime.getToolRegistry().get("fs__read")?.localOnly).toBe(true);

    await drain(runtime.sendMessageStreaming("hi"));
    expect(toolNames(contexts[contexts.length - 1])).toContain("fs__read");

    await drain(
      runtime.sendMessageStreaming("read their files", undefined, { foreignPrincipal: true }),
    );
    expect(toolNames(contexts[contexts.length - 1])).not.toContain("fs__read");

    // A foreign turn naming it anyway is refused by the scoped registry (#880).
    const scoped = runtime as unknown as {
      scopedToolRegistry: ToolRegistry;
      _foreignTurn: boolean;
    };
    scoped._foreignTurn = true;
    try {
      const refused = await scoped.scopedToolRegistry.execute("fs__read", {});
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).not.toContain("OWNER-FILE");
    } finally {
      scoped._foreignTurn = false;
    }
  });

  it("the runtime's mcpServers config path: every discovered tool is localOnly", async () => {
    const contexts: ContextPack[] = [];
    const runtime = new MotebitRuntime(
      {
        motebitId: "owner-mote",
        tickRateHz: 0,
        mcpServers: [{ name: "mail", transport: "stdio", command: "mail-mcp" }],
      },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: recordingProvider(contexts),
      },
    );
    await runtime.init();
    expect(runtime.getToolRegistry().get("mail__read_inbox")?.localOnly).toBe(true);
    await drain(runtime.sendMessageStreaming("send mail", undefined, { foreignPrincipal: true }));
    expect(toolNames(contexts[contexts.length - 1])).not.toContain("mail__read_inbox");
    await drain(runtime.sendMessageStreaming("hi"));
    expect(toolNames(contexts[contexts.length - 1])).toContain("mail__read_inbox");
  });
});
