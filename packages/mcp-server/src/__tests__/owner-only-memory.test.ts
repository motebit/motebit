/**
 * #943 — the owner's memories are served only to the OWNER principal, and
 * the owner principal is the LOCAL STDIO SESSION. HTTP callers are never
 * the owner, whatever the token.
 *
 * `motebit_recall` and the `motebit://memories` resource read the owner's
 * memory graph. Round 2 treated an HTTP caller whose verified token `mid`
 * was this motebit as the owner. That was forgeable: the owner signs such
 * tokens for other parties (`task:submit` to every hired worker, MCP auth
 * to servers it connects to, the relay), and `verifyCallerToken` binds no
 * audience and keeps no replay cache — so any holder could replay one.
 * These tests use REAL Ed25519 keys and the real `verifySignedToken`.
 *
 * Real HTTP, real MCP SDK server (the caller-context.test.ts harness); the
 * stdio case runs the adapter's own server over the SDK's in-memory
 * transport, since a stdio server has no auth context by construction.
 *
 * Tamper: make `servedPrincipal` accept a verified HTTP caller whose `mid`
 * is this motebit (the round-2 rule), or drop the check from the
 * `motebit_recall` handler / the memories resource — the HTTP cases go red.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  bytesToHex,
  createSignedToken,
  generateKeypair,
  verifySignedToken,
} from "@motebit/encryption";
import {
  McpServerAdapter,
  AgentTrustLevel,
  OWNER_ONLY_REFUSAL,
  servedPrincipal,
} from "../index.js";
import type { MotebitServerDeps } from "../index.js";

const OWNER = "owner-0000-0000-0000-000000000943";
const STRANGER = "stranger-0000-0000-0000-00000000943";
const MARK = "OWNERSECRET943";

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const jsonRpc = (id: number, method: string, params: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

async function openSession(port: number, bearer: string): Promise<string | null> {
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
  if (sid == null) return null;
  const ack = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${bearer}`, "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await ack.text();
  return sid;
}

/** One JSON-RPC call on a fresh session; the raw response text (or the auth refusal). */
async function rpc(port: number, bearer: string, method: string, params: unknown): Promise<string> {
  const sid = await openSession(port, bearer);
  if (sid == null) return "(unauthenticated)";
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

function memoryDeps() {
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
    getState: vi.fn(() => ({ attention: 0.42, marker: `${MARK}-state` })),
    getMemories,
    queryMemories,
    logToolCall: () => {},
    // The REAL verifier — no mocked parse.
    verifySignedToken,
  };
  return { deps, queryMemories, getMemories };
}

async function keys() {
  const owner = await generateKeypair();
  const stranger = await generateKeypair();
  return { owner, stranger };
}

async function serveHttp(
  knownCallers: Map<string, { publicKey: string; trustLevel: AgentTrustLevel }>,
  config: { authToken?: string } = {},
) {
  const m = memoryDeps();
  adapter = new McpServerAdapter({ transport: "http", port: 0, ...config, knownCallers }, m.deps);
  process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
  await adapter.start();
  const server = (adapter as unknown as { httpServer: http.Server }).httpServer;
  return { port: (server.address() as AddressInfo).port, ...m };
}

async function tokenFor(mid: string, privateKey: Uint8Array, aud: string): Promise<string> {
  const now = Date.now();
  const token = await createSignedToken(
    { mid, did: `${mid}-device`, iat: now, exp: now + 60_000, jti: crypto.randomUUID(), aud },
    privateKey,
  );
  return `motebit:${token}`;
}

const recall = (port: number, bearer: string) =>
  rpc(port, bearer, "tools/call", { name: "motebit_recall", arguments: { query: "q" } });
const readState = (port: number, bearer: string) =>
  rpc(port, bearer, "resources/read", { uri: "motebit://state" });
const readMemories = (port: number, bearer: string) =>
  rpc(port, bearer, "resources/read", { uri: "motebit://memories" });

describe("#943 — HTTP callers are never the owner", () => {
  it("an owner-signed `task:submit` token (what every hired worker holds) is refused — on first use and on replay", async () => {
    const { owner } = await keys();
    const { port, queryMemories, getMemories } = await serveHttp(
      new Map([
        [OWNER, { publicKey: bytesToHex(owner.publicKey), trustLevel: AgentTrustLevel.Trusted }],
      ]),
    );
    const bearer = await tokenFor(OWNER, owner.privateKey, "task:submit");
    for (let use = 0; use < 2; use++) {
      const r1 = await recall(port, bearer);
      expect(r1).toContain(OWNER_ONLY_REFUSAL);
      expect(r1).not.toContain(MARK);
      const r2 = await readMemories(port, bearer);
      expect(r2).toContain("served only to its owner");
      expect(r2).not.toContain(MARK);
      // The owner's live state vector: same rule (#943 round 4).
      const r3 = await readState(port, bearer);
      expect(r3).toContain("live state is served only to its owner");
      expect(r3).not.toContain(MARK);
    }
    expect(queryMemories).not.toHaveBeenCalled();
    expect(getMemories).not.toHaveBeenCalled();
  });

  it("an owner-signed token of any other audience is refused", async () => {
    const { owner } = await keys();
    const { port, queryMemories, getMemories } = await serveHttp(
      new Map([
        [OWNER, { publicKey: bytesToHex(owner.publicKey), trustLevel: AgentTrustLevel.Trusted }],
      ]),
    );
    for (const aud of ["mcp:connect", "admin:query", "memory:recall", "runtime:attach"]) {
      const bearer = await tokenFor(OWNER, owner.privateKey, aud);
      const r = await recall(port, bearer);
      expect(r, aud).not.toContain(MARK);
      expect(r, aud).toContain(OWNER_ONLY_REFUSAL);
      expect(await readMemories(port, bearer), aud).not.toContain(MARK);
    }
    expect(queryMemories).not.toHaveBeenCalled();
    expect(getMemories).not.toHaveBeenCalled();
  });

  it("another motebit's verified token and a static bearer are refused", async () => {
    const { stranger } = await keys();
    const s = await serveHttp(
      new Map([
        [
          STRANGER,
          { publicKey: bytesToHex(stranger.publicKey), trustLevel: AgentTrustLevel.Trusted },
        ],
      ]),
      { authToken: "shared-secret" },
    );
    const strangerBearer = await tokenFor(STRANGER, stranger.privateKey, "task:submit");
    for (const bearer of [strangerBearer, "shared-secret"]) {
      const r = await recall(s.port, bearer);
      expect(r).toContain(OWNER_ONLY_REFUSAL);
      expect(r).not.toContain(MARK);
      expect(await readMemories(s.port, bearer)).not.toContain(MARK);
    }
    expect(s.queryMemories).not.toHaveBeenCalled();
    expect(s.getMemories).not.toHaveBeenCalled();
  });
});

describe("#943 — the local stdio session is the owner", () => {
  it("stdio is served: recall and the memories resource, with the owner verdict on the dep call", async () => {
    const m = memoryDeps();
    adapter = new McpServerAdapter({ transport: "stdio" }, m.deps);
    const server = await (
      adapter as unknown as {
        createServer(): Promise<{ connect(t: unknown): Promise<void>; close(): Promise<void> }>;
      }
    ).createServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "owner-host", version: "1" });
    await client.connect(clientSide);
    try {
      const r = await client.callTool({ name: "motebit_recall", arguments: { query: "q" } });
      expect(JSON.stringify(r)).toContain(`${MARK}-recall`);
      expect(m.queryMemories).toHaveBeenCalledWith("q", undefined, "owner");
      const res = await client.readResource({ uri: "motebit://memories" });
      expect(JSON.stringify(res)).toContain(`${MARK}-resource`);
      const state = await client.readResource({ uri: "motebit://state" });
      expect(JSON.stringify(state)).toContain(`${MARK}-state`);
      expect(m.getMemories).toHaveBeenCalledWith(50, "owner");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("servedPrincipal: stdio without auth context is the owner; everything else is not", () => {
    const verifiedOwner = {
      authInfo: { extra: { motebit_caller: { motebitId: OWNER, trustLevel: "trusted" } } },
    };
    expect(servedPrincipal(undefined, "stdio")).toBe("owner");
    expect(servedPrincipal({}, "stdio")).toBe("owner");
    expect(servedPrincipal({ authInfo: { extra: {} } }, "stdio")).toBe("other");
    expect(servedPrincipal(undefined, "http")).toBe("other");
    expect(servedPrincipal({ authInfo: { extra: {} } }, "http")).toBe("other");
    expect(servedPrincipal(verifiedOwner, "http")).toBe("other");
  });
});

describe("#943 round 10 — motebit_query runs as the request's served principal", () => {
  it("stdio: the dep runs an OWNER turn and the owner gets the true formation count", async () => {
    const m = memoryDeps();
    const sendMessage = vi.fn(async () => ({ response: "hi", memoriesFormed: 3 }));
    adapter = new McpServerAdapter({ transport: "stdio" }, { ...m.deps, sendMessage });
    const server = await (
      adapter as unknown as {
        createServer(): Promise<{ connect(t: unknown): Promise<void>; close(): Promise<void> }>;
      }
    ).createServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "owner-host", version: "1" });
    await client.connect(clientSide);
    try {
      const r = await client.callTool({ name: "motebit_query", arguments: { message: "q" } });
      expect(sendMessage).toHaveBeenCalledWith("q", "owner");
      expect(JSON.stringify(r)).toContain('\\"memories_formed\\":3');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("HTTP (any credential): the dep runs a FOREIGN turn and memories_formed is 0 on the wire", async () => {
    const { owner } = await keys();
    const sendMessage = vi.fn(async () => ({ response: "hi", memoriesFormed: 3 }));
    const m = memoryDeps();
    adapter = new McpServerAdapter(
      {
        transport: "http",
        port: 0,
        authToken: "shared-secret",
        knownCallers: new Map([
          [OWNER, { publicKey: bytesToHex(owner.publicKey), trustLevel: AgentTrustLevel.Trusted }],
        ]),
      },
      { ...m.deps, sendMessage },
    );
    process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
    await adapter.start();
    const port = (
      (adapter as unknown as { httpServer: http.Server }).httpServer.address() as AddressInfo
    ).port;
    const ownerSigned = await tokenFor(OWNER, owner.privateKey, "task:submit");
    for (const bearer of ["shared-secret", ownerSigned]) {
      sendMessage.mockClear();
      const r = await rpc(port, bearer, "tools/call", {
        name: "motebit_query",
        arguments: { message: "q" },
      });
      expect(sendMessage).toHaveBeenCalledWith("q", "other");
      expect(r).toContain('\\"memories_formed\\":0');
      expect(r).not.toContain('\\"memories_formed\\":3');
    }
  });
});
