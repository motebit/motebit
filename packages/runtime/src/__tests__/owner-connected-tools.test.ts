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

import { connectMcpServers } from "@motebit/mcp-client";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import { foreignTurnTools } from "./helpers/foreign-call";
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

    // A foreign turn naming it anyway is refused by its turn-scoped registry (#880).
    const refused = await foreignTurnTools(runtime).execute("fs__read", {});
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("OWNER-FILE");
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

/** A plain registry, like the CLI's `InMemoryToolRegistry` (no receipt handling). */
function plainRegistry() {
  const tools = new Map<
    string,
    {
      def: import("@motebit/sdk").ToolDefinition;
      h: (a: Record<string, unknown>) => Promise<import("@motebit/sdk").ToolResult>;
    }
  >();
  return {
    has: (n: string) => tools.has(n),
    register: (
      def: import("@motebit/sdk").ToolDefinition,
      h: (a: Record<string, unknown>) => Promise<import("@motebit/sdk").ToolResult>,
    ) => {
      tools.set(def.name, { def, h });
    },
    list: () => [...tools.values()].map((t) => t.def),
    execute: async (n: string, a: Record<string, unknown>) =>
      tools.get(n)?.h(a) ?? { ok: false, error: "unknown" },
  };
}

async function expectForeignCannotReach(
  runtime: MotebitRuntime,
  contexts: ContextPack[],
  name: string,
) {
  expect(runtime.getToolRegistry().get(name)?.localOnly).toBe(true);
  await drain(runtime.sendMessageStreaming("use it", undefined, { foreignPrincipal: true }));
  expect(toolNames(contexts[contexts.length - 1])).not.toContain(name);
  expect((await foreignTurnTools(runtime).execute(name, {})).ok).toBe(false);
  await drain(runtime.sendMessageStreaming("hi"));
  expect(toolNames(contexts[contexts.length - 1])).toContain(name);
}

describe("#943 round 5 — the CLI REPL's MCP wiring", () => {
  const cfg = [{ name: "mail", transport: "stdio" as const, command: "mail-mcp" }];

  it("the CLI order (connect into its own registry → registerExternalTools → init): localOnly, never a foreign turn's", async () => {
    const contexts: ContextPack[] = [];
    const runtime = new MotebitRuntime(
      { motebitId: "owner-mote", tickRateHz: 0, mcpServers: cfg },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: recordingProvider(contexts),
      },
    );
    const mcpRegistry = plainRegistry();
    await connectMcpServers(cfg as never, mcpRegistry as never);
    runtime.registerExternalTools("mcp:config", mcpRegistry as unknown as ToolRegistry);
    await runtime.init();
    await expectForeignCannotReach(runtime, contexts, "mail__read_inbox");
  });

  it("the old CLI pre-merge order (merge into the runtime registry → init) still ends localOnly — the runtime path overwrites it", async () => {
    const contexts: ContextPack[] = [];
    const runtime = new MotebitRuntime(
      { motebitId: "owner-mote", tickRateHz: 0, mcpServers: cfg },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: recordingProvider(contexts),
      },
    );
    const mcpRegistry = plainRegistry();
    await connectMcpServers(cfg as never, mcpRegistry as never);
    runtime.getToolRegistry().merge(mcpRegistry as unknown as ToolRegistry);
    expect(runtime.getToolRegistry().get("mail__read_inbox")?.localOnly).not.toBe(true);
    await runtime.init();
    await expectForeignCannotReach(runtime, contexts, "mail__read_inbox");
  });
});

describe("#943 round 6 — registerExternalTools: the floor does not depend on order", () => {
  it("merge-first (a surface merged the MCP registry before registerExternalTools): still localOnly, never a foreign turn's", async () => {
    const contexts: ContextPack[] = [];
    const runtime = new MotebitRuntime(
      { motebitId: "owner-mote", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: recordingProvider(contexts),
      },
    );
    const reg = fsRegistry();
    runtime.getToolRegistry().merge(reg);
    expect(runtime.getToolRegistry().get("fs__read")?.localOnly).not.toBe(true);
    runtime.registerExternalTools("mcp:fs", reg);
    await expectForeignCannotReach(runtime, contexts, "fs__read");
  });
});
