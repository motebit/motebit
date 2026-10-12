/**
 * #880 F — a tool call is judged under the caller of ITS OWN request.
 *
 * The adapter used to hold the verified caller in one field, written when
 * a request authenticated and read when its tool call ran. Between the two
 * the request body is still being read, so a second caller authenticating
 * in that window overwrote the field and the first request's tool call was
 * evaluated under the second caller's trust — a Verified caller's call
 * judged as a Trusted one's.
 *
 * Real HTTP, real MCP SDK server: caller B authenticates and starts a
 * tools/call whose body is held open; caller A authenticates and completes
 * a call; then B's body finishes. B's validation must see B.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServerAdapter, AgentTrustLevel } from "../index.js";
import type { MotebitServerDeps, CallerIdentity } from "../index.js";
import type { ToolDefinition } from "@motebit/sdk";

const WORKER = "worker-0000-0000-0000-000000000880";
const KEY_A = "aa".repeat(32);
const KEY_B = "bb".repeat(32);

function b64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json)).toString("base64url");
}

/** `motebit:` bearer whose claims name `mid`; the injected verifier accepts it. */
function bearerFor(mid: string): string {
  const now = Date.now();
  return `motebit:${b64url({
    mid,
    did: `${mid}-device`,
    iat: now,
    exp: now + 60_000,
    jti: crypto.randomUUID(),
    aud: "mcp:call",
    sub: WORKER,
  })}.sig`;
}

const PROBE: ToolDefinition = {
  name: "probe",
  description: "Echo who called",
  inputSchema: {
    type: "object",
    properties: { who: { type: "string" } },
    required: ["who"],
  },
};

let adapter: McpServerAdapter | undefined;
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
});

function jsonRpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

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

describe("per-request caller context (#880 F)", () => {
  it("a call whose body is still streaming is judged under its own caller, not the next one to authenticate", async () => {
    const seen: Array<{ who: string; caller: CallerIdentity | undefined }> = [];
    const verifySignedToken = vi.fn(async (token: string) => {
      const claims = JSON.parse(
        Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString(),
      ) as { mid: string; did: string; iat: number; exp: number };
      return claims;
    });
    const deps: MotebitServerDeps = {
      motebitId: WORKER,
      listTools: () => [PROBE],
      filterTools: (t) => t,
      validateTool: (_tool, args, caller) => {
        seen.push({ who: String(args["who"]), caller });
        return { allowed: true, requiresApproval: false };
      },
      executeTool: async () => ({ ok: true, data: "ok" }),
      getState: () => ({}),
      getMemories: async () => [],
      logToolCall: () => {},
      verifySignedToken,
    };
    adapter = new McpServerAdapter(
      {
        transport: "http",
        port: 0,
        knownCallers: new Map([
          ["caller-a", { publicKey: KEY_A, trustLevel: AgentTrustLevel.Trusted }],
          ["caller-b", { publicKey: KEY_B, trustLevel: AgentTrustLevel.Verified }],
        ]),
      },
      deps,
    );
    process.env["MOTEBIT_SELF_WATCHDOG"] = "off";
    await adapter.start();
    const server = (adapter as unknown as { httpServer: http.Server }).httpServer;
    const port = (server.address() as AddressInfo).port;

    const sidA = await openSession(port, bearerFor("caller-a"));
    const sidB = await openSession(port, bearerFor("caller-b"));

    // B: headers (and therefore auth) now, body held open.
    const bodyB = jsonRpc(7, "tools/call", { name: "probe", arguments: { who: "B" } });
    const verifiedBefore = verifySignedToken.mock.calls.length;
    const reqB = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        ...HEADERS,
        Authorization: `Bearer ${bearerFor("caller-b")}`,
        "mcp-session-id": sidB,
        "Content-Length": Buffer.byteLength(bodyB),
      },
    });
    const doneB = new Promise<string>((resolve, reject) => {
      reqB.on("response", (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => resolve(text));
      });
      reqB.on("error", reject);
    });
    reqB.write(bodyB.slice(0, 12));
    // Wait until B's bearer has been verified (auth ran before the body read).
    for (let i = 0; i < 200 && verifySignedToken.mock.calls.length === verifiedBefore; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(verifySignedToken.mock.calls.length).toBeGreaterThan(verifiedBefore);

    // A: authenticates and completes a call while B's body is still open.
    const resA = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        ...HEADERS,
        Authorization: `Bearer ${bearerFor("caller-a")}`,
        "mcp-session-id": sidA,
      },
      body: jsonRpc(8, "tools/call", { name: "probe", arguments: { who: "A" } }),
    });
    await resA.text();

    // B's body finishes; its tool call runs now.
    reqB.end(bodyB.slice(12));
    await doneB;

    const a = seen.find((s) => s.who === "A");
    const b = seen.find((s) => s.who === "B");
    expect(a?.caller).toEqual({
      motebitId: "caller-a",
      trustLevel: AgentTrustLevel.Trusted,
      publicKeyHex: KEY_A,
    });
    expect(b?.caller).toEqual({
      motebitId: "caller-b",
      trustLevel: AgentTrustLevel.Verified,
      publicKeyHex: KEY_B,
    });
  });
});
