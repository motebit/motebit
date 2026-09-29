/**
 * #880 — the triage repros, at the composition root that shipped them.
 *
 * `/serve --operator` with the autonomous preset served `write_file` (and
 * `shell_exec`): `/serve`'s own exclusion list had never named them, and
 * band governance ignored the tool's `requiresApproval`. A remote Verified
 * caller wrote files under cwd with no approval. `rewrite_memory`,
 * `search_conversations` and `recall_self` were served on a default install.
 *
 * This drives the REAL CLI tool registry (`buildToolRegistry`, operator
 * mode), the REAL serve wiring (`wireServerDeps`, as `/serve` builds it)
 * and a REAL HTTP MCP server with a signed-caller bearer — so it goes red
 * if a tool loses its `localOnly` declaration or a serve chokepoint stops
 * honoring it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { McpServerAdapter, wireServerDeps, AgentTrustLevel } from "@motebit/mcp-server";
import type { ServiceRuntime } from "@motebit/mcp-server";
import { PolicyGate } from "@motebit/policy";
import { RiskLevel } from "@motebit/sdk";
import { isServedTool } from "@motebit/runtime";
import { buildToolRegistry } from "../runtime-factory.js";
import type { CliConfig } from "../args.js";

const OWNER = "owner-0000-0000-0000-000000000880";
const PEER = "peer-0000-0000-0000-000000000880";

const OWNER_ONLY = [
  "read_file",
  "write_file",
  "shell_exec",
  "undo_write",
  "recall_memories",
  "rewrite_memory",
  "search_conversations",
  "recall_self",
  "list_events",
  "self_reflect",
];

/**
 * A caller bearer in the #957 shape: `aud: "mcp:call"`, bound to the serving
 * motebit (`sub` = OWNER), fresh `jti`. Called once per request — the server
 * accepts each token once.
 */
function bearerFor(mid: string): string {
  const now = Date.now();
  const claims = Buffer.from(
    JSON.stringify({
      mid,
      did: `${mid}-dev`,
      iat: now,
      exp: now + 60_000,
      jti: crypto.randomUUID(),
      aud: "mcp:call",
      sub: OWNER,
    }),
  ).toString("base64url");
  return `motebit:${claims}.sig`;
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function rpc(
  port: number,
  body: unknown,
  sid?: string,
): Promise<{ sid: string | null; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...HEADERS,
      Authorization: `Bearer ${bearerFor(PEER)}`,
      ...(sid ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify(body),
  });
  return { sid: res.headers.get("mcp-session-id"), text: await res.text() };
}

let adapter: McpServerAdapter | undefined;
let cwd: string | undefined;
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  cwd = undefined;
});

describe("/serve --operator never serves the owner's interior (#880)", () => {
  it("a Verified caller cannot list or call write_file, shell_exec, rewrite_memory or search_conversations", async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-880-"));
    const registry = buildToolRegistry(
      { operator: true, allowedPaths: [cwd] } as unknown as CliConfig,
      { current: null },
      OWNER,
    );
    const registered = registry.list().map((t) => t.name);
    // The builder DID register them — this is about serving, not absence.
    for (const name of OWNER_ONLY) expect(registered, name).toContain(name);

    // The autonomous preset: every R0–R3 call auto-allowed for the owner.
    const policy = new PolicyGate({
      operatorMode: true,
      maxRiskLevel: RiskLevel.R4_MONEY,
      requireApprovalAbove: RiskLevel.R3_EXECUTE,
      denyAbove: RiskLevel.R4_MONEY,
    });
    const runtime = {
      getToolRegistry: () => registry,
      policy,
      getState: () => ({}),
      memory: { exportAll: async () => ({ nodes: [], edges: [] }) },
      events: { append: async () => {} },
    } as unknown as ServiceRuntime;
    // As `/serve` builds it (slash-commands.ts).
    const deps = wireServerDeps(runtime, { motebitId: OWNER });
    const origList = deps.listTools.bind(deps);
    deps.listTools = async () => (await origList()).filter(isServedTool);
    deps.verifySignedToken = vi.fn(async (token: string) => {
      return JSON.parse(
        Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString(),
      ) as { mid: string; did: string; iat: number; exp: number };
    });

    // The wiring-level door: listed set and a direct execute.
    const served = (await deps.listTools()).map((t) => t.name);
    for (const name of OWNER_ONLY) expect(served, name).not.toContain(name);
    expect(served).toContain("web_search");
    const direct = await deps.executeTool("write_file", {
      path: path.join(cwd, "pwned.txt"),
      content: "x",
    });
    expect(direct.ok).toBe(false);

    // The wire: a signed Verified caller over real HTTP.
    process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
    adapter = new McpServerAdapter(
      {
        transport: "http",
        port: 0,
        knownCallers: new Map([
          [PEER, { publicKey: "cc".repeat(32), trustLevel: AgentTrustLevel.Verified }],
        ]),
      },
      deps,
    );
    await adapter.start();
    const port = (
      (adapter as unknown as { httpServer: Server }).httpServer.address() as AddressInfo
    ).port;
    const init = await rpc(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "p", version: "1" },
      },
    });
    const sid = init.sid!;
    expect(sid).toBeTruthy();
    await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);

    const listed = await rpc(
      port,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sid,
    );
    for (const name of OWNER_ONLY) expect(listed.text, name).not.toContain(`"name":"${name}"`);

    for (const [id, name, args] of [
      [3, "write_file", { path: path.join(cwd, "pwned.txt"), content: "owned" }],
      [4, "rewrite_memory", { node_id: "abcd1234", new_content: "x", reason: "y" }],
      [5, "search_conversations", { query: "password" }],
      [6, "shell_exec", { command: "touch", args: [path.join(cwd, "pwned2")] }],
    ] as const) {
      const called = await rpc(
        port,
        { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
        sid,
      );
      // Refused at the wire: an MCP tool error or a JSON-RPC error, never a result.
      expect(called.text, name).toMatch(/"isError":true|"error":\{/);
    }
    expect(fs.existsSync(path.join(cwd, "pwned.txt"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "pwned2"))).toBe(false);
  });
});
