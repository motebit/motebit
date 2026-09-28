/**
 * #943 round 6 — `/mcp remove <server>` takes a config-listed server out of
 * service in the CLI REPL: ONE connection per server, ONE owner.
 *
 * The REPL used to connect each `mcp_servers` entry itself AND hand the same
 * list to the runtime, which connected again during `init()`. Once the
 * runtime's owner-connected registration began to REPLACE same-named tools,
 * every call went through the runtime's connection — and `/mcp remove`
 * disconnected only the REPL's, so the removed server kept answering.
 *
 * A real stdio MCP server (`fixtures/whoami-mcp-server.ts`), wired exactly
 * the way the REPL wires it (`runtimeMcpServersForRepl` for the runtime,
 * `connectConfigMcpServers` for the tools, `disconnectMcpServer` for
 * `/mcp remove`). After the remove: the tool is gone from the registry, a
 * call fails, and no server process is still alive.
 *
 * Tamper: make `runtimeMcpServersForRepl` hand the servers to the runtime
 * (the double connection) — a second server process outlives the remove.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import type { McpServerConfig } from "@motebit/mcp-client";
import {
  connectConfigMcpServers,
  disconnectMcpServer,
  runtimeMcpServersForRepl,
} from "../mcp-config-wiring.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "fixtures", "whoami-mcp-server.ts");

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("#943 — /mcp remove takes a config-listed server out of service (one connection)", () => {
  it("after remove: the tool is gone, a call fails, and no server process survives", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "zz943-mcp-"));
    const log = path.join(dir, "starts.log");
    const servers: McpServerConfig[] = [
      {
        name: "whoami",
        transport: "stdio",
        command: process.execPath,
        args: ["--import", "tsx", SERVER, log],
      },
    ];

    // The REPL's wiring, in the REPL's order.
    const runtime = new MotebitRuntime(
      { motebitId: "owner-mote", tickRateHz: 0, mcpServers: runtimeMcpServersForRepl(servers) },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );
    const { adapters } = await connectConfigMcpServers(runtime, servers);
    await runtime.init();

    const tool = "whoami__whoami";
    expect(runtime.getToolRegistry().get(tool)?.localOnly).toBe(true);
    const before = await runtime.getToolRegistry().execute(tool, {});
    expect(before.ok).toBe(true);
    expect(JSON.stringify(before.data)).toContain("conn:");

    // `/mcp remove whoami`
    await disconnectMcpServer(runtime, adapters, "whoami");

    expect(runtime.getToolRegistry().has(tool)).toBe(false);
    const after = await runtime.getToolRegistry().execute(tool, {});
    expect(after.ok).toBe(false);

    // Exactly one connection was ever made, and it is gone.
    await new Promise((r) => setTimeout(r, 300));
    const pids = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("start "))
      .map((l) => Number(l.slice(6)));
    expect(pids).toHaveLength(1);
    expect(pids.filter(alive)).toEqual([]);
    runtime.stop();
  }, 60_000);
});
