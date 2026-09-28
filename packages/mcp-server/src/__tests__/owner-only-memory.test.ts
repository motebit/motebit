/**
 * #943 — the owner's memories are served only to the OWNER principal.
 *
 * `motebit_recall` and the `motebit://memories` resource read the owner's
 * memory graph. Before this fix any authenticated caller got the owner's
 * none/personal memories back. Now the adapter asks one question of the
 * request's VERIFIED caller context (`servedPrincipal`): stdio is the owner
 * by construction; over HTTP only a verified motebit signed token whose
 * `mid` is this motebit's own id is the owner. Another motebit, the relay,
 * and a static / pluggable bearer are all refused with no memory content,
 * and the memory deps are never called.
 *
 * Real HTTP, real MCP SDK server (the caller-context.test.ts harness).
 *
 * Tamper: make `ownerPrincipal` return "owner" unconditionally, or drop the
 * check from the `motebit_recall` handler / the memories resource — the
 * non-owner cases go red.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  McpServerAdapter,
  AgentTrustLevel,
  OWNER_ONLY_REFUSAL,
  servedPrincipal,
} from "../index.js";
import type { MotebitServerDeps } from "../index.js";

const OWNER = "owner-0000-0000-0000-000000000943";
const MARK = "OWNERSECRET943";

function b64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json)).toString("base64url");
}
function bearerFor(mid: string): string {
  const now = Date.now();
  return `motebit:${b64url({ mid, did: `${mid}-device`, iat: now, exp: now + 60_000 })}.sig`;
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const jsonRpc = (id: number, method: string, params: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

async function openSession(port: number, bearer: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${bearer}` },
    body: jsonRpc(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    }),
  });
  await res.text();
  const sid = res.headers.get("mcp-session-id");
  if (sid == null) throw new Error(`no session (status ${res.status})`);
  const ack = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${bearer}`, "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await ack.text();
  return sid;
}

async function rpc(port: number, bearer: string, method: string, params: unknown): Promise<string> {
  const sid = await openSession(port, bearer);
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${bearer}`, "mcp-session-id": sid },
    body: jsonRpc(2, method, params),
  });
  return res.text();
}

let adapter: McpServerAdapter | undefined;
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
});

async function serve(config: { authToken?: string } = {}) {
  const queryMemories = vi.fn(async () => [
    { content: `${MARK}-recall`, confidence: 0.9, similarity: 0.9 },
  ]);
  const getMemories = vi.fn(async () => [
    { content: `${MARK}-resource`, confidence: 0.9, sensitivity: "none", created_at: 1 },
  ]);
  const deps: MotebitServerDeps = {
    motebitId: OWNER,
    listTools: () => [],
    filterTools: (t) => t,
    validateTool: () => ({ allowed: true, requiresApproval: false }),
    executeTool: async () => ({ ok: true, data: "ok" }),
    getState: () => ({}),
    getMemories,
    queryMemories,
    logToolCall: () => {},
    verifySignedToken: vi.fn(async (token: string) => {
      return JSON.parse(
        Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString(),
      ) as { mid: string; did: string; iat: number; exp: number };
    }),
  };
  adapter = new McpServerAdapter(
    {
      transport: "http",
      port: 0,
      ...config,
      knownCallers: new Map([
        [OWNER, { publicKey: "aa".repeat(32), trustLevel: AgentTrustLevel.Trusted }],
        ["stranger", { publicKey: "bb".repeat(32), trustLevel: AgentTrustLevel.Trusted }],
      ]),
    },
    deps,
  );
  process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
  await adapter.start();
  const server = (adapter as unknown as { httpServer: http.Server }).httpServer;
  return { port: (server.address() as AddressInfo).port, queryMemories, getMemories };
}

const recall = (port: number, bearer: string) =>
  rpc(port, bearer, "tools/call", { name: "motebit_recall", arguments: { query: "q" } });
const readMemories = (port: number, bearer: string) =>
  rpc(port, bearer, "resources/read", { uri: "motebit://memories" });

describe("#943 — the owner's memories are served only to the owner", () => {
  it("a verified non-owner motebit is refused on motebit_recall and the memories resource, with no content", async () => {
    const { port, queryMemories, getMemories } = await serve();
    const r1 = await recall(port, bearerFor("stranger"));
    expect(r1).toContain(OWNER_ONLY_REFUSAL);
    expect(r1).not.toContain(MARK);
    const r2 = await readMemories(port, bearerFor("stranger"));
    expect(r2).toContain("served only to its owner");
    expect(r2).not.toContain(MARK);
    expect(queryMemories).not.toHaveBeenCalled();
    expect(getMemories).not.toHaveBeenCalled();
  });

  it("a static-bearer caller is refused (a shared secret is not owner-only)", async () => {
    const { port, queryMemories, getMemories } = await serve({ authToken: "shared-secret" });
    const r1 = await recall(port, "shared-secret");
    expect(r1).toContain(OWNER_ONLY_REFUSAL);
    expect(r1).not.toContain(MARK);
    const r2 = await readMemories(port, "shared-secret");
    expect(r2).not.toContain(MARK);
    expect(queryMemories).not.toHaveBeenCalled();
    expect(getMemories).not.toHaveBeenCalled();
  });

  it("the owner (a verified token under this motebit's own id) is still served", async () => {
    const { port, queryMemories, getMemories } = await serve();
    expect(await recall(port, bearerFor(OWNER))).toContain(`${MARK}-recall`);
    expect(queryMemories).toHaveBeenCalledWith("q", undefined, "owner");
    expect(await readMemories(port, bearerFor(OWNER))).toContain(`${MARK}-resource`);
    expect(getMemories).toHaveBeenCalledWith(50, "owner");
  });

  it("servedPrincipal: the per-transport classification, fail closed", () => {
    const withCaller = (motebitId: string) => ({
      authInfo: { extra: { motebit_caller: { motebitId, trustLevel: AgentTrustLevel.Trusted } } },
    });
    // stdio: the owner's own MCP host.
    expect(servedPrincipal(undefined, "stdio", OWNER)).toBe("owner");
    expect(servedPrincipal({}, "stdio", OWNER)).toBe("owner");
    // HTTP with no auth context at all: never the owner.
    expect(servedPrincipal({}, "http", OWNER)).toBe("other");
    // HTTP static/pluggable bearer (auth context, no motebit caller).
    expect(servedPrincipal({ authInfo: { extra: {} } }, "http", OWNER)).toBe("other");
    // HTTP verified motebit caller: the owner iff it IS this motebit.
    expect(servedPrincipal(withCaller(OWNER), "http", OWNER)).toBe("owner");
    expect(servedPrincipal(withCaller("stranger"), "http", OWNER)).toBe("other");
    expect(servedPrincipal(withCaller(`relay:${OWNER}`), "http", OWNER)).toBe("other");
  });
});
